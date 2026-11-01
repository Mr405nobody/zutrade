import { z } from 'zod';

export const researchLimits = Object.freeze({
  candidates: 20,
  maxCandidates: 50,
  directoryPages: 5,
  companyPages: 3,
  requests: 80,
  concurrency: 2,
  perHost: 1,
  requestMs: 10000,
  redirects: 3,
  responseBytes: 2097152,
  runMs: 180000,
  retries: 2,
  snapshotBytes: 524288,
});
export const researchRequestSchema = z
  .object({
    commandId: z.uuid(),
    factoryId: z.uuid(),
    productId: z.uuid().nullable().default(null),
    provider: z.enum([
      'public_directory',
      'brave_search',
      'outbound_manual',
      'outbound_unavailable',
    ]),
    directoryId: z
      .enum(['wikimedia-events-gb', 'wikimedia-events-au', 'wikimedia-events-sg'])
      .default('wikimedia-events-sg'),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .default('SG'),
    websiteUrls: z.array(z.url().max(240)).max(20).default([]),
    permissionAcknowledged: z.boolean().default(false),
    buyerType: z.string().trim().min(1).max(120).default('event management'),
    keywords: z.array(z.string().trim().min(1).max(60)).max(8).default(['events', 'promotional']),
    exclusions: z.array(z.string().trim().min(1).max(60)).max(8).default([]),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export type ResearchRequest = z.infer<typeof researchRequestSchema>;
export const evidenceSchema = z
  .object({
    id: z.string(),
    sourceUrl: z.url(),
    finalUrl: z.url().nullable(),
    kind: z.enum(['directory', 'official_website', 'search_summary']),
    observedAt: z.iso.datetime(),
    status: z.enum(['read', 'blocked', 'unsupported', 'failed']),
    title: z.string().max(240),
    excerpts: z.array(z.string().max(500)).max(3),
    fields: z.array(z.string()).max(12),
    fieldBasis: z.record(z.string(), z.string()).optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    hashScope: z.enum(['decoded_response_body', 'normalized_text']).nullable(),
    extractorVersion: z.enum(['d1-static-v1', 'outbound-static-v1']),
    discoveryChain: z.array(z.url()).max(8),
    error: z.string().max(240).nullable(),
    attribution: z.string().max(240),
  })
  .strict();
export type ResearchEvidence = z.infer<typeof evidenceSchema>;
export const candidateSchema = z
  .object({
    key: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string().min(1).max(240),
    sourceUrl: z.url(),
    website: z.url().nullable(),
    domain: z.string().nullable(),
    country: z.string().nullable(),
    description: z.string().max(500),
    publicEmails: z.array(z.string().max(254)).max(5),
    evidence: z.array(evidenceSchema).max(5),
    score: z.number().int(),
    rulesVersion: z.literal('d1-fit-v1'),
    reasons: z
      .array(
        z
          .object({
            rule: z.string(),
            points: z.number().int(),
            evidenceId: z.string(),
            detail: z.string().max(240),
          })
          .strict(),
      )
      .max(24),
    unknownFields: z.array(z.string()).max(12),
    profile: z
      .record(z.string(), z.object({ value: z.string().max(500), sourceUrl: z.url() }).strict())
      .optional(),
  })
  .strict();
export type ResearchCandidate = z.infer<typeof candidateSchema>;
export const researchSnapshotSchema = z
  .object({
    candidates: z.array(candidateSchema).max(50),
    errors: z
      .array(z.object({ url: z.string().max(2048), code: z.string().max(240) }).strict())
      .max(80),
    truncationReason: z.string().nullable(),
  })
  .strict();
export type ResearchSnapshot = z.infer<typeof researchSnapshotSchema>;
export const reviewInputSchema = z
  .object({
    candidateKey: z.string().regex(/^[a-f0-9]{64}$/),
    resultVersion: z.number().int().positive(),
    reviewRevision: z.string().regex(/^\d+$/),
    decision: z.enum(['keep', 'exclude']),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export const importCandidateSchema = z
  .object({
    commandId: z.uuid(),
    candidateKey: z.string().regex(/^[a-f0-9]{64}$/),
    resultVersion: z.number().int().positive(),
    reviewRevision: z.string().regex(/^\d+$/),
    buyerId: z.uuid().nullable().default(null),
    identityConfirmed: z.literal(true),
  })
  .strict();
export type ReviewInput = z.infer<typeof reviewInputSchema>;
export type ImportCandidateInput = z.infer<typeof importCandidateSchema>;
export interface ResearchReview {
  decision: 'keep' | 'exclude';
  reason: string;
  memberId: string;
  at: string;
  revision: string;
}
export interface ResearchRunView {
  data_origin: 'live_network' | 'offline_fixture';
  id: string;
  factory_id: string;
  provider: string;
  state: 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
  request: ResearchRequest;
  request_sha256: string;
  execution_version: number;
  result_version: number;
  results_snapshot: ResearchSnapshot;
  review_decisions: Record<string, ResearchReview>;
  review_revision: string;
  request_count: number;
  first_started_at: string | null;
  deadline: string | null;
  finished_at: string | null;
  created_at: string;
  error: string | null;
  candidate_count: number;
}
export interface ResearchDetail {
  run: ResearchRunView;
  duplicates: Record<string, { id: string; name: string; domain: string | null }[]>;
  imported: Record<string, string>;
}
export interface ResearchOptions {
  directories: {
    id: string;
    label: string;
    country: string;
    coverage: string;
    source: string;
    license: string;
  }[];
  brave: { enabled: boolean; detail: string };
  limits: typeof researchLimits;
}
