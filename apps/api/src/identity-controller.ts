import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  approverChangeSchema,
  factoryRenameSchema,
  memberChangeSchema,
  profileChangeSchema,
} from '@zutrade/contracts';
import {
  BoundaryError,
  createAuth,
  createAuthPool,
  createDatabase,
  createQueue,
  discoverMemberships,
  fromNodeHeaders,
  requireFactory,
  requireOwner,
  resolveIdentity,
  transaction,
  withWorkspace,
  renameFactoryAndEnqueue,
} from '@zutrade/db';
import type { Context } from '@zutrade/db';
import { loadConfig } from '@zutrade/config';

const config = loadConfig();
export const business = createDatabase(config.API_DATABASE_URL, 'zutrade-api-business');
export const authPool = createAuthPool(config.AUTH_DATABASE_URL);
export const auth: ReturnType<typeof createAuth> = createAuth(
  authPool,
  config.BETTER_AUTH_SECRET,
  config.WEB_PORT,
  config.API_PORT,
);
export const queue: ReturnType<typeof createQueue> = createQueue(config.API_DATABASE_URL);
export function parse<T>(
  schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false } },
  input: unknown,
): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestException('请求字段或格式不正确');
  return result.data;
}
export function uuid(id: string) {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))
    throw new BadRequestException('无效标识');
  return id;
}
export async function verified(request: Request) {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session) throw new UnauthorizedException('请先登录');
  return session.user;
}
export async function handle<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BoundaryError) throw new HttpException(error.message, error.status);
    throw error;
  }
}
export async function scoped<T>(
  request: Request,
  workspaceId: string,
  run: (context: Context) => Promise<T>,
) {
  const session = await verified(request);
  return handle(() => withWorkspace(business.pool, session, uuid(workspaceId), run));
}

@Controller('api')
export class IdentityController {
  @Get('me')
  async me(@Req() request: Request) {
    const session = await verified(request);
    return handle(() =>
      transaction(business.pool, async (client) => {
        const user = await resolveIdentity(client, session);
        const memberships = await discoverMemberships(client, user.id);
        return {
          user: { id: user.id, display_name: user.display_name, status: user.status },
          memberships,
        };
      }),
    );
  }
  @Patch('me')
  async profile(@Req() request: Request, @Body() body: unknown) {
    const input = parse(profileChangeSchema, body);
    const session = await verified(request);
    return handle(() =>
      transaction(business.pool, async (client) => {
        const user = await resolveIdentity(client, session);
        await client.query('UPDATE app.app_users SET display_name=$1 WHERE id=$2', [
          input.displayName,
          user.id,
        ]);
        return { displayName: input.displayName };
      }),
    );
  }
  @Get('workspaces/:workspaceId/factories')
  factories(@Req() request: Request, @Param('workspaceId') workspaceId: string) {
    return scoped(
      request,
      workspaceId,
      async ({ client, member }) =>
        (
          await client.query(
            `SELECT id,name,factory_code,status FROM app.factories f WHERE workspace_id=$1 AND ($2::boolean OR EXISTS(SELECT 1 FROM app.factory_memberships fm WHERE fm.workspace_id=f.workspace_id AND fm.factory_id=f.id AND fm.member_id=$3)) ORDER BY factory_code`,
            [workspaceId, member.all_factories, member.id],
          )
        ).rows,
    );
  }
  @Get('workspaces/:workspaceId/factories/:factoryId')
  factory(
    @Req() request: Request,
    @Param('workspaceId') workspaceId: string,
    @Param('factoryId') factoryId: string,
  ) {
    return scoped(request, workspaceId, (context) => requireFactory(context, uuid(factoryId)));
  }
  @Patch('workspaces/:workspaceId/factories/:factoryId')
  rename(
    @Req() request: Request,
    @Param('workspaceId') workspaceId: string,
    @Param('factoryId') factoryId: string,
    @Body() body: unknown,
  ) {
    const input = parse(factoryRenameSchema, body);
    return scoped(request, workspaceId, (context) =>
      renameFactoryAndEnqueue(context, queue, uuid(factoryId), input.name, input.commandId),
    );
  }
  @Get('workspaces/:workspaceId/members')
  members(@Req() request: Request, @Param('workspaceId') workspaceId: string) {
    return scoped(request, workspaceId, async (context) => {
      requireOwner(context);
      return (
        await context.client.query(
          `SELECT m.id,u.display_name,m.role,m.status,m.all_factories,COALESCE((SELECT jsonb_agg(fm.factory_id ORDER BY fm.factory_id) FROM app.factory_memberships fm WHERE fm.workspace_id=m.workspace_id AND fm.member_id=m.id),'[]'::jsonb) AS factory_ids FROM app.workspace_members m JOIN app.app_users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY m.created_at,m.id`,
          [workspaceId],
        )
      ).rows;
    });
  }
  @Patch('workspaces/:workspaceId/members/:memberId')
  changeMember(
    @Req() request: Request,
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Body() body: unknown,
  ) {
    const input = parse(memberChangeSchema, body);
    return scoped(request, workspaceId, async (context) => {
      requireOwner(context);
      uuid(memberId);
      if (memberId === context.member.id) throw new BoundaryError(409, '不能在这里更改自己的权限');
      const target = (
        await context.client.query(
          'SELECT id FROM app.workspace_members WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
          [workspaceId, memberId],
        )
      ).rows[0];
      if (!target) throw new BoundaryError(404, '成员不存在');
      if (
        memberId === context.member.approver_member_id &&
        (input.role !== 'owner' || input.status !== 'active')
      )
        throw new BoundaryError(409, '请先指定其他有效 owner 为审批人');
      for (const id of input.factoryIds) await requireFactory(context, id);
      await context.client.query(
        'UPDATE app.workspace_members SET role=$1,status=$2,all_factories=$3 WHERE workspace_id=$4 AND id=$5',
        [input.role, input.status, input.allFactories, workspaceId, memberId],
      );
      await context.client.query(
        'DELETE FROM app.factory_memberships WHERE workspace_id=$1 AND member_id=$2',
        [workspaceId, memberId],
      );
      for (const id of new Set(input.factoryIds))
        await context.client.query(
          'INSERT INTO app.factory_memberships(workspace_id,factory_id,member_id) VALUES($1,$2,$3)',
          [workspaceId, id, memberId],
        );
      await context.client.query(
        `INSERT INTO app.audit_events(workspace_id,actor_member_id,actor_kind,action,aggregate_type,aggregate_id,details) VALUES($1,$2,'member','a1.member-changed','workspace_member',$3,$4)`,
        [workspaceId, context.member.id, memberId, JSON.stringify(input)],
      );
      return { updated: true };
    });
  }
  @Post('workspaces/:workspaceId/approver')
  approver(
    @Req() request: Request,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    const input = parse(approverChangeSchema, body);
    return scoped(request, workspaceId, async (context) => {
      requireOwner(context);
      const target = (
        await context.client.query(
          "SELECT m.id FROM app.workspace_members m JOIN app.app_users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.id=$2 AND m.role='owner' AND m.status='active' AND u.status='active' FOR SHARE OF m",
          [workspaceId, input.memberId],
        )
      ).rows[0];
      if (!target) throw new BoundaryError(409, '审批人必须是当前有效 owner');
      await context.client.query('UPDATE app.workspaces SET approver_member_id=$1 WHERE id=$2', [
        input.memberId,
        workspaceId,
      ]);
      await context.client.query(
        `INSERT INTO app.audit_events(workspace_id,actor_member_id,actor_kind,action,aggregate_type,aggregate_id,details) VALUES($1,$2,'member','a1.approver-changed','workspace',$1,$3)`,
        [workspaceId, context.member.id, JSON.stringify(input)],
      );
      return { updated: true };
    });
  }
  @Get('workspaces/:workspaceId/tasks')
  tasks(@Req() request: Request, @Param('workspaceId') workspaceId: string) {
    return scoped(
      request,
      workspaceId,
      async ({ client, member }) =>
        (
          await client.query(
            `SELECT e.id,e.aggregate_id,e.pg_boss_job_id,e.created_at,j.state AS queue_state,
      EXISTS(SELECT 1 FROM app.audit_events a WHERE a.workspace_id=e.workspace_id AND a.correlation_id=e.id AND a.action='a1.probe-consumed') AS consumed
      FROM app.outbox_events e LEFT JOIN pgboss.job j ON j.id=e.pg_boss_job_id AND j.name=e.handler_key WHERE e.workspace_id=$1 AND e.handler_key='a1.identity-probe' AND (e.payload->>'memberId')=$2 ORDER BY e.created_at DESC LIMIT 10`,
            [workspaceId, member.id],
          )
        ).rows,
    );
  }
}
