import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export class BoundaryError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface Identity {
  id: string;
  auth_subject: string;
  display_name: string;
  status: string;
}
export interface Member {
  id: string;
  workspace_id: string;
  user_id: string;
  role: 'owner' | 'sales';
  status: string;
  all_factories: boolean;
  workspace_name: string;
  approver_member_id: string | null;
}
export interface Context {
  client: pg.PoolClient;
  orm: NodePgDatabase;
  user: Identity;
  member: Member;
}

export async function transaction<T>(
  pool: pg.Pool,
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    // Clear all context even if a caller had previously set a session value.
    await client.query(
      `SELECT set_config('app.auth_subject','',true), set_config('app.user_id','',true), set_config('app.workspace_id','',true), set_config('app.inbound_event_id','',true), set_config('app.delivery_result_request_id','',true), set_config('app.delivery_result_thread_id','',true), set_config('app.delivery_result_token','',true)`,
    );
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    client.release(broken);
  }
}
// subject and name must come only from auth.api.getSession, never request body/headers.
export async function resolveIdentity(
  client: pg.PoolClient,
  verified: { id: string; name: string },
): Promise<Identity> {
  await client.query(`SELECT set_config('app.auth_subject', $1, true)`, [verified.id]);
  let row = (
    await client.query<Identity>(
      'SELECT id, auth_subject, display_name, status FROM app.app_users WHERE auth_subject=$1',
      [verified.id],
    )
  ).rows[0];
  if (!row) {
    await client.query(
      'INSERT INTO app.app_users(auth_subject,display_name) VALUES($1,$2) ON CONFLICT(auth_subject) DO NOTHING',
      [verified.id, verified.name],
    );
    row = (
      await client.query<Identity>(
        'SELECT id, auth_subject, display_name, status FROM app.app_users WHERE auth_subject=$1',
        [verified.id],
      )
    ).rows[0];
  }
  if (!row || row.status !== 'active') throw new BoundaryError(403, '账号已停用');
  await client.query(`SELECT set_config('app.user_id',$1,true)`, [row.id]);
  return row;
}
export async function discoverMemberships(
  client: pg.PoolClient,
  userId: string,
): Promise<Member[]> {
  return (
    await client.query<Member>(
      `SELECT m.id,m.workspace_id,m.user_id,m.role,m.status,m.all_factories,w.name AS workspace_name,w.approver_member_id
    FROM app.workspace_members m JOIN app.workspaces w ON w.id=m.workspace_id
    WHERE m.user_id=$1 AND m.status='active' AND w.status='active' AND m.role IN ('owner','sales') ORDER BY w.name,m.id`,
      [userId],
    )
  ).rows;
}
export async function establishWorkspace(
  client: pg.PoolClient,
  userId: string,
  workspaceId: string,
): Promise<Member> {
  // C serializes workspace authorization, evidence/context changes and send claims.
  // Take this before member or other row locks; re-read membership after waiting.
  await client.query('SELECT app.c_lock_workspace($1)', [workspaceId]);
  // Membership discovery precedes the selected workspace. Lock and recheck the member
  // after selection to serialize member/ACL revocation with business commands.
  const member = (await discoverMemberships(client, userId)).find(
    (m) => m.workspace_id === workspaceId,
  );
  if (!member) throw new BoundaryError(403, '没有此工作区的有效成员资格');
  await client.query(`SELECT set_config('app.workspace_id',$1,true)`, [workspaceId]);
  const locked = (
    await client.query<Member>(
      `SELECT m.id,m.workspace_id,m.user_id,m.role,m.status,m.all_factories,w.name AS workspace_name,w.approver_member_id
    FROM app.workspaces w JOIN app.workspace_members m ON m.workspace_id=w.id
    WHERE w.id=$1 AND m.id=$2 AND m.user_id=$3 AND w.status='active' AND m.status='active' AND m.role IN ('owner','sales') FOR SHARE OF m`,
      [workspaceId, member.id, userId],
    )
  ).rows[0];
  if (!locked) throw new BoundaryError(403, '成员资格已变更，请重新选择工作区');
  return locked;
}
export async function withWorkspace<T>(
  pool: pg.Pool,
  verified: { id: string; name: string },
  workspaceId: string,
  run: (context: Context) => Promise<T>,
): Promise<T> {
  return transaction(pool, async (client) => {
    const user = await resolveIdentity(client, verified);
    const member = await establishWorkspace(client, user.id, workspaceId);
    return run({ client, orm: drizzle(client), user, member });
  });
}
export function requireOwner(context: Context) {
  if (context.member.role !== 'owner') throw new BoundaryError(403, '仅 owner 可以管理成员');
}
export function requireApprover(context: Context) {
  requireOwner(context);
  if (context.member.approver_member_id !== context.member.id)
    throw new BoundaryError(403, '只有指定且有效的 owner 可以批准商业承诺');
}
export async function requireFactory(
  context: Pick<Context, 'client' | 'member'>,
  factoryId: string,
  forUpdate = false,
) {
  const row = (
    await context.client.query<{ id: string; name: string; factory_code: string; status: string }>(
      `SELECT id,name,factory_code,status FROM app.factories f
    WHERE f.id=$1 AND f.workspace_id=$2 AND ($3::boolean OR EXISTS(SELECT 1 FROM app.factory_memberships fm WHERE fm.workspace_id=f.workspace_id AND fm.factory_id=f.id AND fm.member_id=$4)) FOR ${forUpdate ? 'UPDATE' : 'SHARE'} OF f`,
      [factoryId, context.member.workspace_id, context.member.all_factories, context.member.id],
    )
  ).rows[0];
  if (!row) throw new BoundaryError(404, '工厂不存在或未获授权');
  return row;
}

/** Business expiry uses the database clock after lock acquisition, not the host clock. */
export async function databaseNow(client: pg.PoolClient): Promise<Date> {
  return (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
}
