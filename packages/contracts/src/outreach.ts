import { z } from 'zod';
const revision = z.string().regex(/^[1-9]\d*$/);
export const timeZoneSchema = z
  .string()
  .max(100)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, '需要有效 IANA 时区');
/** Local wall times are never silently shifted across DST gaps or overlaps. */
export function resolveLocalTime(
  local: string,
  zone: string,
  choice: 'reject' | 'earlier' | 'later' = 'reject',
) {
  timeZoneSchema.parse(zone);
  if (!/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local))
    throw new Error('请输入 2000—2099 年的本地日期时间');
  const base = Date.parse(local + ':00Z');
  if (!Number.isFinite(base) || new Date(base).toISOString().slice(0, 16) !== local)
    throw new Error('日期时间无效');
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const wall = (ms: number) => {
    const p = Object.fromEntries(fmt.formatToParts(ms).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  };
  const offsets = new Set<number>();
  for (let h = -36; h <= 36; h += 6) {
    const sample = base + h * 3600000;
    offsets.add(Date.parse(wall(sample) + ':00Z') - sample);
  }
  const matches = [...offsets]
    .map((offset) => base - offset)
    .filter((ms) => wall(ms) === local)
    .sort((a, b) => a - b);
  if (!matches.length) throw new Error('该本地时间因夏令时切换不存在，请选择其他时间');
  if (matches.length > 1 && choice === 'reject')
    throw new Error('该本地时间出现两次，请明确选择较早或较晚时刻');
  return new Date(choice === 'later' ? matches[matches.length - 1]! : matches[0]!).toISOString();
}
export const demoContactSchema = z
  .object({
    commandId: z.uuid(),
    leadId: z.uuid(),
    accountId: z.uuid(),
    simulationAuthorized: z.literal(true),
  })
  .strict();
export const batchDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    factoryId: z.uuid(),
    timeZone: timeZoneSchema,
    startAt: z.iso.datetime(),
    deadline: z.iso.datetime(),
    intervalMs: z.number().int().min(1000).max(3600000),
    items: z
      .array(
        z
          .object({
            threadId: z.uuid(),
            leadId: z.uuid(),
            quoteVersionId: z.uuid().nullable(),
            subject: z.string().max(500),
            body: z.string().trim().min(1).max(10000),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export const saveBatchSchema = z
  .object({
    commandId: z.uuid(),
    batchId: z.uuid().nullable(),
    expectedVersion: revision.nullable(),
    draft: batchDraftSchema,
  })
  .strict();
export const freezeBatchSchema = z
  .object({ commandId: z.uuid(), expectedVersion: revision })
  .strict();
export const batchDecisionSchema = z
  .object({
    commandId: z.uuid(),
    versionId: z.uuid(),
    snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
    expectedVersion: revision,
    decision: z.enum(['approve', 'reject', 'revoke']),
    reason: z.string().max(1000).default(''),
  })
  .strict();
export const followupSchema = z
  .object({
    commandId: z.uuid(),
    followupId: z.uuid().nullable(),
    expectedVersion: revision.nullable(),
    threadId: z.uuid(),
    opportunityId: z.uuid(),
    ownerMemberId: z.uuid(),
    quoteVersionId: z.uuid().nullable(),
    purpose: z.string().trim().min(1).max(500),
    internalDraft: z.string().max(10000),
    mode: z.enum(['manual', 'approved_automatic']).default('manual'),
    localTime: z.string(),
    timeZone: timeZoneSchema,
    disambiguation: z.enum(['reject', 'earlier', 'later']).default('reject'),
    subject: z.string().max(500).default('Follow-up'),
    body: z.string().max(10000).default(''),
  })
  .strict();
export type BatchDraft = z.infer<typeof batchDraftSchema>;
export interface D2LeadView {
  channels: { threadId: string; accountId: string; pointId: string; permitted: boolean }[];
  factoryName: string;
  id: string;
  factory_id: string;
  buyer_id: string;
  name: string;
  origin: string;
  identityConfirmed: boolean;
  source: unknown;
  points: {
    id: string;
    identity: string;
    source: unknown;
    identityStatus: string;
    permissions: unknown[];
  }[];
  threadId: string | null;
  accountId: string | null;
}
export interface D2BatchView {
  id: string;
  name: string;
  factory_id: string;
  row_version: string;
  state: string;
  draft: BatchDraft;
  current_version_id: string | null;
  versions: {
    id: string;
    version_no: number;
    send_rules: BatchDraft;
    snapshot_sha256: string;
    invalidated_at: string | null;
    valid_until: string;
    approval: { id: string; state: string; row_version: string; reason: string | null } | null;
    items: {
      id: string;
      outbound_request_id: string;
      payload_version_id: string;
      payload_sha256: string;
      scheduled_at: string;
      state: string;
      stop_reason: string | null;
      cancel_requested_at: string | null;
      dispatch_claimed_at: string | null;
      subject: string;
      body_text: string;
      recipients_snapshot: { identity: string }[];
      sender_snapshot: { displayName: string };
      attachment_manifest: { filename: string; sha256: string }[];
      quote_version_id: string | null;
    }[];
  }[];
  summary: Record<string, number>;
}
export interface FollowupView {
  id: string;
  thread_id: string;
  opportunity_id: string;
  owner_member_id: string;
  quote_version_id: string | null;
  outbound_request_id: string | null;
  purpose: string;
  execution_mode: string;
  state: string;
  due_at: string;
  time_zone: string;
  internal_draft: string;
  business_version: string;
  row_version: string;
  stop_reason: string | null;
  plan_snapshot: {
    body: string;
    subject: string;
    localTime: string;
    disambiguation: 'reject' | 'earlier' | 'later';
  };
  history: { id: string; action: string; occurred_at: string; details: unknown }[];
}
export interface D2Workspace {
  leads: D2LeadView[];
  batches: D2BatchView[];
  followups: FollowupView[];
  accounts: { id: string; display_name: string }[];
  members: { id: string; display_name: string }[];
  tasks: { id: string; kind: string; reason: string; threadId: string | null }[];
}
