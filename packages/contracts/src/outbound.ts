import { z } from 'zod';
import type { ResearchCandidate, ResearchRunView } from './prospecting.js';
export const outboundInputSchema = z
  .object({
    commandId: z.uuid(),
    factoryId: z.uuid(),
    product: z.string().trim().min(2).max(60),
    country: z.string().regex(/^[A-Z]{2}$/),
    buyerType: z.enum(['Importer', 'Distributor', 'Wholesaler']),
    limit: z.number().int().min(1).max(20).default(20),
    mode: z.enum(['automatic', 'manual']),
    websiteUrls: z.array(z.url().max(240)).max(20).default([]),
    permissionAcknowledged: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.mode === 'manual' && (!v.websiteUrls.length || !v.permissionAcknowledged))
      c.addIssue({ code: 'custom', message: '手动导入需要官网 URL 和公开资料使用权限确认' });
  });
export type OutboundInput = z.infer<typeof outboundInputSchema>;
export const outboundReviewSchema = z
  .object({
    revision: z.string().regex(/^\d+$/),
    status: z.enum(['approved', 'rejected', 'needs_info']),
    notes: z.string().trim().min(1).max(1000),
    corrections: z
      .object({
        name: z.string().trim().max(240),
        country: z.string().trim().max(100),
        address: z.string().trim().max(500),
        business: z.string().trim().max(500),
        buyerType: z.string().trim().max(120),
        sourceUrl: z.union([z.literal(''), z.url().max(240)]),
      })
      .strict(),
  })
  .strict();
export type OutboundReviewInput = z.infer<typeof outboundReviewSchema>;
export interface OutboundCompany {
  id: string;
  factory_id: string;
  domain: string;
  run_id: string;
  candidate_key: string;
  name: string;
  review_status: 'pending' | 'approved' | 'rejected' | 'needs_info';
  revision: string;
  corrections: OutboundReviewInput['corrections'] | Record<string, never>;
  review_notes: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  reviewer_name: string | null;
  country: string | null;
  data_origin: string;
}
export interface DueDiligenceReport {
  generator: 'rules';
  version: 'outbound-rules-v1';
  investigatedAt: string | null;
  facts: { label: string; value: string; sourceUrl: string | null }[];
  productMatch: string;
  buyerMatch: string;
  marketMatch: string;
  inferences: string[];
  risks: string[];
  unknowns: string[];
  recommendation: string;
}
export interface OutboundCompanyDetail {
  company: OutboundCompany;
  candidate: ResearchCandidate;
  report: DueDiligenceReport;
  history: { at: string; actor: string; details: unknown }[];
}
export interface OutboundDashboard {
  automatic: { available: false; detail: string };
  runs: ResearchRunView[];
  companies: OutboundCompany[];
}
export function outboundQueries(product: string, country: string, buyerType: string): string[] {
  const market =
    (
      {
        US: 'United States',
        GB: 'United Kingdom',
        SG: 'Singapore',
        AU: 'Australia',
        DE: 'Germany',
        CA: 'Canada',
      } as Record<string, string>
    )[country] ?? country;
  return [
    ...new Set([
      `${product} ${buyerType.toLowerCase()} ${market}`,
      `${product} importers ${market}`,
      `wholesale ${product} ${market}`,
      ...(/fastener/i.test(product) ? [`bolts nuts distributors ${market}`] : []),
    ]),
  ].slice(0, 4);
}
