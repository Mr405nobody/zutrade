export type GatewayIntent =
  'human_reply' | 'quote' | 'faq' | 'clarification' | 'outreach' | 'followup';
/** Reserved producers are not available commands until their owning stage is implemented. */
export type FutureGatewayProducer =
  | {
      origin: 'automatic_faq';
      intent: 'faq' | 'clarification';
      policyVersion: string;
      contextRevision: string;
    }
  | {
      origin: 'automatic_followup';
      intent: 'followup';
      planVersion: string;
      contextRevision: string;
    }
  | {
      origin: 'approved_batch';
      intent: 'outreach';
      batchVersionId: string;
      contextRevision: string;
    };
export interface ApprovalView {
  id: string;
  state: string;
  payload_version_id: string;
  snapshot_sha256: string;
  row_version: string;
  expires_at: string;
  reason: string | null;
}
export interface OutboundView {
  request: {
    provider_capabilities?: { idempotent: boolean } | null;
    id: string;
    thread_id: string;
    intent: string;
    state: string;
    row_version: string;
    stop_reason: string | null;
    cancel_requested_at: string | null;
    dispatch_claimed_at: string | null;
  };
  payload: {
    id: string;
    version_no: number;
    body_text: string;
    subject: string | null;
    quote_version_id: string | null;
    snapshot_sha256: string;
    recipients_snapshot: { identity: string }[];
    attachment_manifest: { filename: string; sha256: string }[];
  };
  approvals: ApprovalView[];
  events: { id: string; event_kind: string; reason: string; created_at: string }[];
  attempts: Record<string, unknown>[];
  audit: Record<string, unknown>[];
  versions: {
    id: string;
    version_no: number;
    body_text: string;
    subject: string | null;
    quote_version_id: string | null;
  }[];
}
