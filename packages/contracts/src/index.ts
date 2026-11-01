import { z } from 'zod';

export const APP_VERSION = '0.0.0-stage.e';
export const probeSchema = z.object({
  status: z.enum(['ok', 'error', 'unknown']),
  checkedAt: z.iso.datetime(),
  latencyMs: z.number().nonnegative(),
  detail: z.string(),
  version: z.string().nullable(),
});
export type Probe = z.infer<typeof probeSchema>;
export const modesSchema = z.object({
  channel: z.literal('simulation'),
  ai: z.enum(['mock', 'preset']),
  prospecting: z.enum(['live_public_directory', 'live_search_api']),
});
export type RuntimeModes = z.infer<typeof modesSchema>;
export const workerHealthSchema = z.object({
  service: z.literal('worker'),
  status: z.enum(['ready', 'not_ready']),
  version: z.string(),
  nodeVersion: z.string(),
  checkedAt: z.iso.datetime(),
  startedAt: z.iso.datetime(),
  instanceId: z.uuid(),
  heartbeatAt: z.iso.datetime().nullable(),
  database: probeSchema,
  modes: modesSchema,
});
export type WorkerHealth = z.infer<typeof workerHealthSchema>;
export const readinessSchema = z.object({
  service: z.literal('api'),
  status: z.enum(['ready', 'not_ready']),
  version: z.string(),
  nodeVersion: z.string(),
  checkedAt: z.iso.datetime(),
  database: probeSchema,
  worker: probeSchema,
  modes: modesSchema,
});
export type Readiness = z.infer<typeof readinessSchema>;

export const memberViewSchema = z.object({
  id: z.uuid(),
  workspace_id: z.uuid(),
  user_id: z.uuid(),
  role: z.enum(['owner', 'sales']),
  status: z.enum(['active', 'disabled']),
  all_factories: z.boolean(),
  workspace_name: z.string(),
  approver_member_id: z.uuid().nullable(),
});
export const identityViewSchema = z.object({
  user: z.object({ id: z.uuid(), display_name: z.string(), status: z.string() }),
  memberships: z.array(memberViewSchema),
});
export type IdentityView = z.infer<typeof identityViewSchema>;
export type MemberView = z.infer<typeof memberViewSchema>;
export const factoryViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  factory_code: z.string(),
  status: z.string(),
});
export type FactoryView = z.infer<typeof factoryViewSchema>;
export const factoryRenameSchema = z
  .object({ name: z.string().trim().min(1).max(120), commandId: z.uuid() })
  .strict();
export const memberChangeSchema = z
  .object({
    role: z.enum(['owner', 'sales']),
    status: z.enum(['active', 'disabled']),
    allFactories: z.boolean(),
    factoryIds: z.array(z.uuid()).max(100),
  })
  .strict();
export const profileChangeSchema = z
  .object({ displayName: z.string().trim().min(1).max(80) })
  .strict();
export const approverChangeSchema = z.object({ memberId: z.uuid() }).strict();
export const workspaceMemberSchema = z.object({
  id: z.uuid(),
  display_name: z.string(),
  role: z.enum(['owner', 'sales']),
  status: z.enum(['active', 'disabled']),
  all_factories: z.boolean(),
  factory_ids: z.array(z.uuid()),
});
export type WorkspaceMemberView = z.infer<typeof workspaceMemberSchema>;

export type { Requirements, QuoteLine, QuoteSnapshot } from './quote.js';

export * from './approval.js';
export * from './prospecting.js';
export * from './outreach.js';
export * from './ai.js';

export * from './outbound.js';
