import { z } from 'zod';
export const AI_SCENARIO_VERSION = 'ct01.v1';
export const AI_FAQ_VALUES = {
  material: ['12oz', '12oz cotton', '12oz cotton canvas'],
  dimensions: ['35×40cm'],
} as const;
export const AI_BUSINESS_CLOCK = '2026-10-29T00:00:00.000Z';
export const aiTask = z.enum(['requirements', 'retrieval', 'answer', 'quote_input', 'followup']);
export const aiEvidenceSchema = z
  .object({
    factVersionId: z.uuid(),
    sourceVersionId: z.uuid(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    locator: z.string().max(1000),
    excerpt: z.string().max(1000),
  })
  .strict();
export const aiContextSchema = z
  .object({
    workspaceId: z.uuid(),
    factoryId: z.uuid(),
    threadId: z.uuid(),
    opportunityId: z.uuid(),
    productId: z.uuid(),
    sku: z.string(),
    threadRevision: z.string(),
    requirementsRevision: z.string(),
    opportunityVersion: z.string(),
    controlMode: z.enum(['human', 'assisted']),
    paused: z.boolean(),
    messageId: z.uuid(),
    facts: z
      .array(
        z
          .object({
            specifications: z
              .object({
                fabric: z.string(),
                dimensions: z.string(),
                color: z.string(),
                printing: z.string(),
              })
              .strict(),
            evidence: z.array(aiEvidenceSchema).min(1),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
export const aiInputSchema = z
  .object({
    task: aiTask,
    text: z.string().min(1).max(8000),
    scenarioVersion: z.literal(AI_SCENARIO_VERSION),
    businessClock: z.iso.datetime(),
    context: aiContextSchema,
  })
  .strict();
export const aiOutputSchema = z
  .object({
    schemaVersion: z.literal('e-output.v1'),
    scenarioId: z.enum([
      'material',
      'dimensions',
      'quote500',
      'quantity800',
      'discount',
      'arrival',
      'sample',
      'retrieval',
      'followup',
      'unsupported',
      'injection',
    ]),
    scenarioVersion: z.literal(AI_SCENARIO_VERSION),
    status: z.enum(['suggestion', 'needs_human']),
    task: aiTask,
    summary: z.string().min(1).max(2000),
    reason: z.string().max(1000).nullable(),
    evidence: z.array(aiEvidenceSchema).max(100),
    faq: z
      .object({
        templateId: z.enum(['material', 'dimensions']),
        templateVersion: z.literal(1),
        body: z.string().max(2000),
      })
      .strict()
      .nullable(),
    quantity: z.enum(['500', '800']).nullable(),
    retrieval: z
      .object({ request: z.string().max(1000) })
      .strict()
      .nullable(),
    followup: z
      .object({ purpose: z.string(), suggestedAt: z.iso.datetime(), internalDraft: z.string() })
      .strict()
      .nullable(),
    requiresApproval: z.boolean(),
  })
  .strict();
export type AIInput = z.infer<typeof aiInputSchema>;
export type AIContext = z.infer<typeof aiContextSchema>;
export type AIOutput = z.infer<typeof aiOutputSchema>;
export const startAIInput = z
  .object({
    commandId: z.uuid(),
    opportunityId: z.uuid(),
    productId: z.uuid(),
    task: aiTask,
    autoFaq: z.boolean().default(false),
  })
  .strict();
export const decideAIInput = z
  .object({
    commandId: z.uuid(),
    decision: z.enum(['adopt', 'modify', 'reject']),
    editedText: z.string().trim().min(1).max(4000).optional(),
    localTime: z.string().optional(),
    timeZone: z.string().optional(),
  })
  .strict();
export interface AIRunView {
  id: string;
  state: string;
  scenario_id: string;
  scenario_version: string;
  business_clock: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  error_detail: string | null;
  proposed_action: AIOutput | null;
  validation_result: { valid: boolean; reason: string | null } | null;
  input_references: { input: AIInput; contextHash: string };
  decision: string | null;
  decision_text: string | null;
  decision_result: Record<string, unknown> | null;
  faqAction: { status: string; reason: string | null; requestId: string | null } | null;
  current: boolean;
  staleReason: string | null;
  input_tokens: null;
  output_tokens: null;
}
