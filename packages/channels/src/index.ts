import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
export const CHANNEL_MODE = 'simulation' as const;
export type ChannelMode = typeof CHANNEL_MODE;
export interface SimulationIdentity {
  namespace: 'zutrade-simulation';
  scopeKey: string;
  value: string;
}
export interface SimulationInbound {
  eventId: string;
  providerMessageId: string;
  identity: string | null;
  displayName: string;
  body: string;
  occurredAt: string;
  factoryId?: string | null;
}
export interface NormalizedInbound {
  eventKey: string;
  providerMessageId: string;
  identity: SimulationIdentity | null;
  displayName: string;
  body: string;
  occurredAt: string;
  simulation: true;
}
export interface SimulationSend {
  dispatchToken: string;
  requestId: string;
  accountId: string;
  providerIdempotencyKey: string;
  payloadSha256: string;
  content: Record<string, unknown>;
  attachments: { sha256: string; bytes: Uint8Array }[];
}
export interface SimulationResult {
  dispatchToken: string;
  state: 'simulated';
  providerMessageId: string;
  acceptanceId: string;
  completedAt: string;
  responseCode: 'SIMULATED';
  payloadSha256: string;
}
export type MockScenario = 'normal' | 'reject' | 'delay' | 'lost_response' | 'callbacks';
export interface MockCapabilities {
  idempotent: boolean;
  guaranteeSeconds: number;
  scenario: MockScenario;
}
export const normalMock: MockCapabilities = {
  idempotent: true,
  guaranteeSeconds: 86400,
  scenario: 'normal',
};
export class ProviderRejection extends Error {}
export class ProviderConflict extends Error {}
interface Acceptance {
  dispatch_token: string;
  id: string;
  payload_sha256: string;
  accepted_at: Date;
  guarantee_until: Date;
}
const resultOf = (a: Acceptance): SimulationResult => ({
  dispatchToken: a.dispatch_token,
  state: 'simulated',
  providerMessageId: `simulation:${a.id}`,
  acceptanceId: a.id,
  completedAt: a.accepted_at.toISOString(),
  responseCode: 'SIMULATED',
  payloadSha256: a.payload_sha256,
});
/** Separate connection/commit. No access to app approvals, claims or actor permissions. */
export class MockAdapter {
  private pool: pg.Pool | undefined;
  constructor(connectionString = process.env.SIMULATION_DATABASE_URL) {
    if (connectionString) {
      const u = new URL(connectionString);
      if (u.username !== 'zutrade_simulation') throw new Error('Simulation requires isolated role');
      this.pool = new pg.Pool({ connectionString, max: 2, allowExitOnIdle: true });
    }
  }
  normalize(input: SimulationInbound, accountId: string): NormalizedInbound {
    const identity = input.identity?.trim();
    return {
      eventKey: input.eventId,
      providerMessageId: input.providerMessageId,
      identity: identity
        ? { namespace: 'zutrade-simulation', scopeKey: accountId, value: identity }
        : null,
      displayName: input.displayName.trim(),
      body: input.body,
      occurredAt: new Date(input.occurredAt).toISOString(),
      simulation: true,
    };
  }
  async send(input: SimulationSend, capabilities = normalMock): Promise<SimulationResult> {
    if (!this.pool) throw new Error('Persistent simulation ledger is not configured');
    for (const a of input.attachments)
      if (createHash('sha256').update(a.bytes).digest('hex') !== a.sha256)
        throw new Error('Attachment bytes differ');
    const invocationId = randomUUID();
    await this.pool.query(
      'INSERT INTO simulation.invocations(id,account_id,request_id,provider_key,payload_sha256,dispatch_token,idempotent,scenario) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        invocationId,
        input.accountId,
        input.requestId,
        input.providerIdempotencyKey,
        input.payloadSha256,
        input.dispatchToken,
        capabilities.idempotent,
        capabilities.scenario,
      ],
    );
    if (capabilities.scenario === 'delay') await new Promise((r) => setTimeout(r, 250));
    const c = await this.pool.connect();
    let accepted: Acceptance | undefined,
      outcome = 'accepted';
    try {
      await c.query('BEGIN');
      // Even non-idempotent calls serialize ledger writes, but are NEVER deduplicated.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `mock:${input.accountId}:${input.providerIdempotencyKey}`,
      ]);
      if (capabilities.idempotent) {
        accepted = (
          await c.query<Acceptance>(
            'SELECT * FROM simulation.acceptances WHERE account_id=$1 AND provider_key=$2 AND idempotent',
            [input.accountId, input.providerIdempotencyKey],
          )
        ).rows[0];
        if (
          accepted &&
          (accepted.payload_sha256 !== input.payloadSha256 ||
            accepted.guarantee_until.getTime() <=
              (
                await c.query<{ now: Date }>('SELECT clock_timestamp() AS now')
              ).rows[0]!.now.getTime())
        )
          outcome = 'conflict';
        else if (accepted) outcome = 'reused';
      }
      if (outcome !== 'conflict' && capabilities.scenario === 'reject' && !accepted)
        outcome = 'rejected';
      if (outcome === 'accepted' && !accepted)
        accepted = (
          await c.query<Acceptance>(
            `INSERT INTO simulation.acceptances(id,account_id,request_id,provider_key,payload_sha256,idempotent,guarantee_until,content,attachment_digests,dispatch_token) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+$7*interval '1 second',$8,$9,$10) RETURNING *`,
            [
              randomUUID(),
              input.accountId,
              input.requestId,
              input.providerIdempotencyKey,
              input.payloadSha256,
              capabilities.idempotent,
              capabilities.guaranteeSeconds,
              JSON.stringify(input.content),
              JSON.stringify(
                input.attachments.map((a) => ({
                  sha256: a.sha256,
                  byteLength: a.bytes.byteLength,
                })),
              ),
              input.dispatchToken,
            ],
          )
        ).rows[0];
      await c.query(
        'INSERT INTO simulation.calls(id,account_id,request_id,provider_key,payload_sha256,idempotent,scenario,outcome,acceptance_id,dispatch_token) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          invocationId,
          input.accountId,
          input.requestId,
          input.providerIdempotencyKey,
          input.payloadSha256,
          capabilities.idempotent,
          capabilities.scenario,
          outcome,
          accepted?.id ?? null,
          input.dispatchToken,
        ],
      );
      if (accepted && outcome !== 'conflict') {
        for (const kind of capabilities.scenario === 'callbacks'
          ? ['accepted', 'delayed', 'accepted', 'rejected']
          : ['accepted'])
          await c.query(
            'INSERT INTO simulation.callbacks(id,acceptance_id,kind) VALUES($1,$2,$3)',
            [randomUUID(), accepted.id, kind],
          );
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
    if (outcome === 'conflict')
      throw new ProviderConflict('Provider key conflict or guarantee expired');
    if (outcome === 'rejected') throw new ProviderRejection('Explicit rejection; no acceptance');
    if (capabilities.scenario === 'lost_response') throw new Error('Accepted but response lost');
    return resultOf(accepted!);
  }
  async lookup(accountId: string, key: string, digest: string) {
    if (!this.pool) throw new Error('Persistent simulation ledger is not configured');
    const rows = (
      await this.pool.query<Acceptance>(
        'SELECT * FROM simulation.acceptances WHERE account_id=$1 AND provider_key=$2 ORDER BY accepted_at,id',
        [accountId, key],
      )
    ).rows;
    if (rows.some((r) => r.payload_sha256 !== digest))
      throw new ProviderConflict('Ledger content conflict');
    return {
      conclusion: rows.length ? ('accepted' as const) : ('inconclusive' as const),
      source: 'simulation.acceptances',
      results: rows.map(resultOf),
    };
  }
  async callbacks(accountId: string, key: string, digest: string) {
    if (!this.pool) throw new Error('Persistent ledger not configured');
    const rows = (
      await this.pool.query<Acceptance & { event_id: string; kind: string }>(
        'SELECT a.*,c.id AS event_id,c.kind FROM simulation.callbacks c JOIN simulation.acceptances a ON a.id=c.acceptance_id WHERE a.account_id=$1 AND a.provider_key=$2 AND a.payload_sha256=$3 ORDER BY c.created_at,c.id',
        [accountId, key, digest],
      )
    ).rows;
    return rows.map((r) => ({ id: r.event_id, kind: r.kind, result: resultOf(r) }));
  }
  async close() {
    await this.pool?.end();
  }
}
