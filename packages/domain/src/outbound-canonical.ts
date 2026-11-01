import { createHash } from 'node:crypto';

/** c-outbound-v1: NFC/LF strings, code-unit sorted keys, ordered arrays, explicit nulls. */
export function normalizeOutbound<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/\r\n?/g, '\n').normalize('NFC') as T;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Only safe integer metadata is canonical');
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeOutbound) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value).map(
      ([k, v]) => [k.normalize('NFC'), normalizeOutbound(v)] as const,
    );
    if (new Set(entries.map(([k]) => k)).size !== entries.length)
      throw new Error('Duplicate normalized key');
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries) as T;
  }
  throw new Error('Missing/undefined/non-JSON canonical value');
}
export function outboundCanonicalJSON(value: unknown) {
  return JSON.stringify(normalizeOutbound(value));
}
export function outboundHash(value: unknown) {
  return createHash('sha256').update(outboundCanonicalJSON(value), 'utf8').digest('hex');
}
export interface AttachmentManifest {
  artifactId: string;
  quoteVersionId: string;
  quoteSnapshotSha256: string;
  objectKey: string;
  objectVersion: string;
  sha256: string;
  filename: string;
  contentType: 'application/pdf';
  byteLength: number;
}
export interface OutboundPayload {
  id: string;
  outbound_request_id: string;
  version_no: number;
  quote_version_id: string | null;
  quote_snapshot_sha256: string | null;
  thread_context_revision: string;
  requirements_revision: string | null;
  policy_version: string;
  language_code: string;
  subject: string | null;
  body_text: string;
  body_html: string | null;
  sender_snapshot: Record<string, unknown>;
  recipients_snapshot: Record<string, unknown>[];
  attachment_manifest: AttachmentManifest[];
  channel_payload: Record<string, unknown>;
  snapshot_sha256: string;
  frozen_at: string | null;
  invalidated_at: string | null;
}
export function outboundSnapshot(
  p: Omit<
    OutboundPayload,
    'id' | 'outbound_request_id' | 'version_no' | 'snapshot_sha256' | 'frozen_at' | 'invalidated_at'
  >,
) {
  return normalizeOutbound({
    protocol: 'c-outbound-v1',
    sender: p.sender_snapshot,
    recipients: p.recipients_snapshot,
    subject: p.subject,
    body: p.body_text,
    html: p.body_html,
    quoteVersionId: p.quote_version_id,
    quoteSnapshotSha256: p.quote_snapshot_sha256,
    attachments: p.attachment_manifest,
    threadContextRevision: String(p.thread_context_revision),
    requirementsRevision: p.requirements_revision === null ? null : String(p.requirements_revision),
    policyVersion: String(p.policy_version),
    language: p.language_code,
    channel: p.channel_payload,
  });
}
