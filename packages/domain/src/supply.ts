import { createHash } from 'node:crypto';
import { BoundaryError, requireFactory, requireOwner } from '@zutrade/db';
import type { Context } from '@zutrade/db';
import { z } from 'zod';
import { requireThread } from './inbox.js';

const decimal = z.string().regex(/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/);
const date = z.iso.datetime({ offset: true });
const text = z.string().trim().min(1).max(1000);
export const supplyValueSchema = z
  .object({
    seller: z.object({ name: text }).strict(),
    specifications: z
      .object({ fabric: text, dimensions: text, color: text, printing: text })
      .strict(),
    production: z
      .object({
        days: z.number().int().min(0).max(3650),
        dayKind: z.enum(['business', 'calendar']),
        startConditions: text,
      })
      .strict(),
    discountBoundary: z
      .object({
        basis: z.literal('product_subtotal'),
        maxPercent: decimal.refine((value) => Number(value) <= 100, '折扣边界不能超过100%'),
      })
      .strict(),
    sampleTerms: text,
    exclusions: z.array(text).min(1).max(12),
    simulation: z.literal(true),
  })
  .strict();
export const productInput = z
  .object({
    factoryId: z.uuid(),
    sku: z.string().trim().min(1).max(64),
    name: text,
    unitCode: z.literal('piece').default('piece'),
    configuration: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export const sourceInput = z
  .object({
    title: text,
    sourceDocumentId: z.uuid().optional(),
    expectedVersion: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .optional(),
    kind: z.enum(['file', 'manual', 'simulation']),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    contentType: z.string().max(100),
    contentSize: z.number().int().nonnegative().max(10485760),
    objectKey: z.string().max(200).optional(),
    extractedSnapshot: z.record(z.string(), z.unknown()).default({}),
    validUntil: date,
  })
  .strict();
export const factDraftInput = z
  .object({
    sourceVersionId: z.uuid(),
    locator: text,
    excerpt: text,
    factKey: z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/),
    scopeKey: z.string().max(100).default('default'),
    value: supplyValueSchema,
    applicability: z.record(z.string(), z.string()).default({}),
    validUntil: date,
    disclosure: z.enum(['internal', 'buyer_visible']).default('buyer_visible'),
  })
  .strict();
export const priceInput = factDraftInput
  .omit({ factKey: true, disclosure: true })
  .extend({
    qtyMin: decimal,
    qtyMax: decimal.nullable(),
    unitCode: z.literal('piece'),
    currencyCode: z.literal('USD'),
    unitPrice: decimal,
    setupFee: decimal,
  })
  .strict();
export const withdrawInput = z.object({ reason: text }).strict();
export function supplyCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(supplyCanonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${supplyCanonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const hash = (v: unknown) => createHash('sha256').update(supplyCanonical(v)).digest('hex');
async function audit(c: Context, action: string, id: string, details: object = {}) {
  await c.client.query(
    `INSERT INTO app.audit_events(workspace_id,actor_member_id,actor_kind,action,aggregate_type,aggregate_id,details) VALUES($1,$2,'member',$3,'supply',$4,$5)`,
    [c.member.workspace_id, c.member.id, action, id, JSON.stringify(details)],
  );
}
export async function lockSupplyProduct(c: Pick<Context, 'client'>, id: string) {
  await c.client.query(`SELECT pg_advisory_xact_lock(hashtextextended('b-product:'||$1,0))`, [id]);
}
export async function requireProduct(c: Context, id: string) {
  const p = (
    await c.client.query(`SELECT * FROM app.products WHERE workspace_id=$1 AND id=$2`, [
      c.member.workspace_id,
      id,
    ])
  ).rows[0];
  if (!p) throw new BoundaryError(404, '产品不存在或未获授权');
  await requireFactory(c, p.factory_id);
  return p;
}
export async function listProducts(c: Context) {
  return {
    items: (
      await c.client.query(
        `SELECT p.*,f.name AS factory_name FROM app.products p JOIN app.factories f ON f.workspace_id=p.workspace_id AND f.id=p.factory_id WHERE p.workspace_id=$1 ORDER BY p.created_at DESC LIMIT 100`,
        [c.member.workspace_id],
      )
    ).rows,
  };
}
export async function productDetail(c: Context, id: string) {
  const product = await requireProduct(c, id);
  const sources = (
    await c.client.query(
      `SELECT d.id AS document_id,d.title,d.source_kind,d.state AS document_state,d.current_version_id=v.id AS is_current,d.row_version AS document_row_version,v.* FROM app.source_documents d JOIN app.source_versions v ON v.workspace_id=d.workspace_id AND v.source_document_id=d.id WHERE d.workspace_id=$1 AND d.product_id=$2 ORDER BY v.created_at DESC LIMIT 100`,
      [c.member.workspace_id, id],
    )
  ).rows;
  const facts = (
    await c.client.query(
      `SELECT f.fact_key,f.scope_key,f.current_version_id,v.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('source_version_id',e.source_version_id,'locator',e.locator,'excerpt',e.excerpt)) FROM app.fact_evidence e WHERE e.workspace_id=v.workspace_id AND e.fact_version_id=v.id),'[]') AS evidence FROM app.facts f JOIN app.fact_versions v ON v.workspace_id=f.workspace_id AND v.fact_id=f.id WHERE f.workspace_id=$1 AND f.product_id=$2 ORDER BY v.created_at DESC LIMIT 100`,
      [c.member.workspace_id, id],
    )
  ).rows;
  const prices = (
    await c.client.query(
      `SELECT p.*,v.state AS fact_state,v.invalidated_at,f.current_version_id=v.id AS is_current,v.applicability, (f.current_version_id=v.id AND v.state='published' AND v.invalidated_at IS NULL AND v.valid_from<=now() AND v.valid_until>now() AND p.valid_from<=now() AND p.valid_until>now() AND NOT EXISTS(SELECT 1 FROM app.fact_evidence e JOIN app.source_versions sv ON sv.workspace_id=e.workspace_id AND sv.id=e.source_version_id JOIN app.source_documents sd ON sd.workspace_id=sv.workspace_id AND sd.id=sv.source_document_id WHERE e.workspace_id=v.workspace_id AND e.fact_version_id=v.id AND (sv.revoked_at IS NOT NULL OR sv.valid_until<=now() OR sd.state<>'active' OR sd.current_version_id IS DISTINCT FROM sv.id))) AS usable FROM app.price_rules p JOIN app.fact_versions v ON v.workspace_id=p.workspace_id AND v.id=p.fact_version_id JOIN app.facts f ON f.workspace_id=v.workspace_id AND f.id=v.fact_id WHERE p.workspace_id=$1 AND p.product_id=$2 ORDER BY p.created_at DESC LIMIT 100`,
      [c.member.workspace_id, id],
    )
  ).rows;
  return { product, sources, facts, prices };
}
export async function createProduct(c: Context, input: z.infer<typeof productInput>) {
  await requireFactory(c, input.factoryId);
  const p = (
    await c.client.query(
      `INSERT INTO app.products(workspace_id,factory_id,sku,name,unit_code,configuration_schema,state) VALUES($1,$2,$3,$4,$5,$6,'active') RETURNING *`,
      [
        c.member.workspace_id,
        input.factoryId,
        input.sku,
        input.name,
        input.unitCode,
        JSON.stringify(input.configuration),
      ],
    )
  ).rows[0];
  await audit(c, 'b.product-created', p.id);
  return p;
}
export async function createSource(
  c: Context,
  productId: string,
  input: z.infer<typeof sourceInput>,
) {
  const p = await requireProduct(c, productId);
  await lockSupplyProduct(c, p.id);
  if (new Date(input.validUntil).getTime() <= Date.now())
    throw new BoundaryError(400, '来源有效期必须在未来');
  let d;
  if (input.sourceDocumentId) {
    d = (
      await c.client.query(
        `SELECT * FROM app.source_documents WHERE workspace_id=$1 AND id=$2 AND factory_id=$3 AND product_id=$4 FOR UPDATE`,
        [c.member.workspace_id, input.sourceDocumentId, p.factory_id, p.id],
      )
    ).rows[0];
    if (!d || d.state !== 'active')
      throw new BoundaryError(409, '来源已撤回、归档或不属于此产品，请新建资料');
    if (d.row_version !== input.expectedVersion)
      throw new BoundaryError(409, '资料已有新版本，请刷新后重试');
    if (d.source_kind !== input.kind) throw new BoundaryError(409, '来源类型不可在版本间改变');
  } else
    d = (
      await c.client.query(
        `INSERT INTO app.source_documents(workspace_id,factory_id,product_id,title,source_kind) VALUES($1,$2,$3,$4,$5) RETURNING id`,
        [c.member.workspace_id, p.factory_id, p.id, input.title, input.kind],
      )
    ).rows[0];
  const v = (
    await c.client.query(
      `INSERT INTO app.source_versions(workspace_id,factory_id,source_document_id,version_no,object_key,content_sha256,content_type,content_size,extracted_snapshot,observed_at,valid_until,recorded_by_member_id) SELECT $1,$2,$3,COALESCE(max(version_no),0)+1,$4,$5,$6,$7,$8,now(),$9,$10 FROM app.source_versions WHERE workspace_id=$1 AND source_document_id=$3 RETURNING *`,
      [
        c.member.workspace_id,
        p.factory_id,
        d.id,
        input.objectKey ?? null,
        input.contentSha256,
        input.contentType,
        input.contentSize,
        JSON.stringify(input.extractedSnapshot),
        input.validUntil,
        c.member.id,
      ],
    )
  ).rows[0];
  await c.client.query(
    `UPDATE app.source_documents SET current_version_id=$1,title=$4 WHERE workspace_id=$2 AND id=$3`,
    [v.id, c.member.workspace_id, d.id, input.title],
  );
  await audit(c, 'b.source-created', v.id, {
    productId: p.id,
    simulation: input.kind === 'simulation',
  });
  return v;
}
async function currentSource(c: Context, id: string, productId: string) {
  const v = (
    await c.client.query(
      `SELECT v.*,d.state AS document_state,d.current_version_id,d.product_id FROM app.source_versions v JOIN app.source_documents d ON d.workspace_id=v.workspace_id AND d.id=v.source_document_id WHERE v.workspace_id=$1 AND v.id=$2 AND d.product_id=$3`,
      [c.member.workspace_id, id, productId],
    )
  ).rows[0];
  if (
    !v ||
    v.document_state !== 'active' ||
    v.revoked_at ||
    v.current_version_id !== id ||
    new Date(v.valid_until).getTime() <= Date.now()
  )
    throw new BoundaryError(409, '来源未确认、已过期、撤回或不适用于此产品');
  return v;
}
export async function createFactDraft(
  c: Context,
  productId: string,
  input: z.infer<typeof factDraftInput>,
) {
  const p = await requireProduct(c, productId);
  await lockSupplyProduct(c, p.id);
  const s = await currentSource(c, input.sourceVersionId, p.id);
  if (
    new Date(input.validUntil).getTime() > new Date(s.valid_until).getTime() ||
    new Date(input.validUntil).getTime() <= Date.now()
  )
    throw new BoundaryError(400, '事实有效期须在来源有效期内且尚未到期');
  if (Number(input.value.discountBoundary.maxPercent) > 100)
    throw new BoundaryError(400, '折扣边界不能超过100%');
  const f = (
    await c.client.query(
      `INSERT INTO app.facts(workspace_id,factory_id,product_id,fact_key,scope_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,factory_id,product_id,fact_key,scope_key) DO UPDATE SET fact_key=EXCLUDED.fact_key RETURNING *`,
      [c.member.workspace_id, p.factory_id, p.id, input.factKey, input.scopeKey],
    )
  ).rows[0];
  const v = (
    await c.client.query(
      `INSERT INTO app.fact_versions(workspace_id,factory_id,fact_id,version_no,value_kind,value,applicability,disclosure,valid_from,valid_until) SELECT $1,$2,$3,COALESCE(max(version_no),0)+1,'structured',$4,$5,$6,now(),$7 FROM app.fact_versions WHERE workspace_id=$1 AND fact_id=$3 RETURNING *`,
      [
        c.member.workspace_id,
        p.factory_id,
        f.id,
        JSON.stringify(input.value),
        JSON.stringify(input.applicability),
        input.disclosure,
        input.validUntil,
      ],
    )
  ).rows[0];
  await c.client.query(
    `INSERT INTO app.fact_evidence(workspace_id,factory_id,fact_version_id,source_version_id,locator,excerpt) VALUES($1,$2,$3,$4,$5,$6)`,
    [
      c.member.workspace_id,
      p.factory_id,
      v.id,
      input.sourceVersionId,
      input.locator,
      input.excerpt,
    ],
  );
  await audit(c, 'b.fact-draft-created', v.id);
  return v;
}
async function factProduct(c: Context, id: string) {
  const v = (
    await c.client.query(
      `SELECT v.*,f.product_id,f.current_version_id,f.fact_key FROM app.fact_versions v JOIN app.facts f ON f.workspace_id=v.workspace_id AND f.id=v.fact_id WHERE v.workspace_id=$1 AND v.id=$2`,
      [c.member.workspace_id, id],
    )
  ).rows[0];
  if (!v || !v.product_id) throw new BoundaryError(404, '事实不存在或未获授权');
  await requireProduct(c, v.product_id);
  await lockSupplyProduct(c, v.product_id);
  return (
    await c.client.query(
      `SELECT v.*,f.product_id,f.current_version_id,f.fact_key FROM app.fact_versions v JOIN app.facts f ON f.workspace_id=v.workspace_id AND f.id=v.fact_id WHERE v.workspace_id=$1 AND v.id=$2`,
      [c.member.workspace_id, id],
    )
  ).rows[0];
}
export async function publishFact(c: Context, id: string) {
  requireOwner(c);
  const v = await factProduct(c, id);
  if (v.state === 'published' && v.current_version_id === id) return v;
  if (
    v.current_version_id &&
    (
      await c.client.query(
        'SELECT version_no FROM app.fact_versions WHERE workspace_id=$1 AND id=$2',
        [c.member.workspace_id, v.current_version_id],
      )
    ).rows[0]?.version_no >= v.version_no
  )
    throw new BoundaryError(409, '已有更新的已发布版本，请重建事实');
  if (v.frozen_at || v.state !== 'draft')
    throw new BoundaryError(409, '事实已冻结或失效，请建立新版本');
  supplyValueSchema.parse(v.value);
  const evidence = (
    await c.client.query(
      `SELECT * FROM app.fact_evidence WHERE workspace_id=$1 AND fact_version_id=$2 ORDER BY id`,
      [c.member.workspace_id, id],
    )
  ).rows;
  if (!evidence.length) throw new BoundaryError(409, '缺少来源和定位片段');
  for (const e of evidence) {
    const s = await currentSource(c, e.source_version_id, v.product_id);
    if (
      !e.locator ||
      !e.excerpt ||
      new Date(v.valid_until).getTime() > new Date(s.valid_until).getTime()
    )
      throw new BoundaryError(409, '事实证据不完整或有效期超出来源');
  }
  if (!v.valid_until || new Date(v.valid_until).getTime() <= Date.now())
    throw new BoundaryError(409, '事实已过期');
  if (v.current_version_id)
    await c.client.query(
      `UPDATE app.fact_versions SET state='superseded',invalidated_at=now(),invalidation_reason='已发布新事实版本' WHERE workspace_id=$1 AND id=$2`,
      [c.member.workspace_id, v.current_version_id],
    );
  const result = (
    await c.client.query(
      `UPDATE app.fact_versions SET state='published',verified_by_member_id=$1,verified_at=now(),snapshot_sha256=$2,frozen_at=now() WHERE workspace_id=$3 AND id=$4 RETURNING *`,
      [
        c.member.id,
        hash({
          value: v.value,
          applicability: v.applicability,
          disclosure: v.disclosure,
          valid_until: v.valid_until,
          evidence,
        }),
        c.member.workspace_id,
        id,
      ],
    )
  ).rows[0];
  await c.client.query(
    `UPDATE app.facts SET current_version_id=$1 WHERE workspace_id=$2 AND id=$3`,
    [id, c.member.workspace_id, v.fact_id],
  );
  await audit(c, 'b.fact-published', id);
  return result;
}
export async function publishPrice(
  c: Context,
  productId: string,
  input: z.infer<typeof priceInput>,
) {
  requireOwner(c);
  const p = await requireProduct(c, productId);
  await lockSupplyProduct(c, p.id);
  if (
    !Number.isSafeInteger(Number(input.qtyMin)) ||
    Number(input.qtyMin) <= 0 ||
    (input.qtyMax !== null &&
      (!Number.isSafeInteger(Number(input.qtyMax)) || Number(input.qtyMax) <= Number(input.qtyMin)))
  )
    throw new BoundaryError(400, '整件价阶须使用有效整数半开区间');
  if (input.unitCode !== p.unit_code) throw new BoundaryError(400, '价格单位与产品不一致');
  const scope = `${input.scopeKey}:${input.currencyCode}:${input.unitCode}:${input.qtyMin}`;
  const overlap = (
    await c.client.query(
      `SELECT p.id FROM app.price_rules p JOIN app.fact_versions v ON v.workspace_id=p.workspace_id AND v.id=p.fact_version_id JOIN app.facts f ON f.workspace_id=v.workspace_id AND f.id=v.fact_id WHERE p.workspace_id=$1 AND p.product_id=$2 AND p.currency_code=$3 AND p.unit_code=$4 AND NOT EXISTS(SELECT 1 FROM jsonb_each_text(v.applicability) a WHERE $5::jsonb ? a.key AND $5::jsonb->>a.key<>a.value) AND f.current_version_id=v.id AND v.state='published' AND v.invalidated_at IS NULL AND p.valid_from<=now() AND (p.valid_until IS NULL OR p.valid_until>now()) AND (v.valid_until IS NULL OR v.valid_until>now()) AND NOT(f.fact_key='price_rule' AND f.scope_key=$6) AND p.qty_min<COALESCE($8::numeric,'Infinity'::numeric) AND COALESCE(p.qty_max,'Infinity'::numeric)>$7::numeric`,
      [
        c.member.workspace_id,
        p.id,
        input.currencyCode,
        input.unitCode,
        JSON.stringify(input.applicability),
        scope,
        input.qtyMin,
        input.qtyMax,
      ],
    )
  ).rows;
  if (overlap.length) throw new BoundaryError(409, '当前有效价阶范围重叠，请先撤回或更新原价阶');
  const draft = await createFactDraft(c, p.id, {
    ...input,
    factKey: 'price_rule',
    scopeKey: scope,
    disclosure: 'buyer_visible',
  });
  const rule = (
    await c.client.query(
      `INSERT INTO app.price_rules(workspace_id,factory_id,product_id,fact_version_id,scope_key,qty_min,qty_max,unit_code,currency_code,unit_price,setup_fee,tax_scope,shipping_scope,terms,valid_from,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'excluded','excluded',$12,now(),$13) RETURNING *`,
      [
        c.member.workspace_id,
        p.factory_id,
        p.id,
        draft.id,
        input.scopeKey,
        input.qtyMin,
        input.qtyMax,
        input.unitCode,
        input.currencyCode,
        input.unitPrice,
        input.setupFee,
        JSON.stringify(input.value),
        input.validUntil,
      ],
    )
  ).rows[0];
  await publishFact(c, draft.id);
  await audit(c, 'b.price-published', rule.id, { factVersionId: draft.id });
  return rule;
}
export async function withdrawFact(c: Context, id: string, reason: string) {
  requireOwner(c);
  await factProduct(c, id);
  const v = (
    await c.client.query(
      `UPDATE app.fact_versions SET state='revoked',invalidated_at=COALESCE(invalidated_at,now()),invalidation_reason=$1 WHERE workspace_id=$2 AND id=$3 RETURNING *`,
      [reason, c.member.workspace_id, id],
    )
  ).rows[0];
  await audit(c, 'b.fact-withdrawn', id, { reason });
  return v;
}
export async function requireSource(c: Context, id: string) {
  const v = (
    await c.client.query(
      `SELECT v.*,d.product_id,d.title FROM app.source_versions v JOIN app.source_documents d ON d.workspace_id=v.workspace_id AND d.id=v.source_document_id WHERE v.workspace_id=$1 AND v.id=$2`,
      [c.member.workspace_id, id],
    )
  ).rows[0];
  if (!v) throw new BoundaryError(404, '来源不存在或未获授权');
  await requireFactory(c, v.factory_id);
  const detached = (
    await c.client.query(
      `SELECT 1 FROM app.fact_evidence fe JOIN app.quote_evidence qe ON qe.workspace_id=fe.workspace_id AND qe.fact_version_id=fe.fact_version_id JOIN app.quote_versions qv ON qv.workspace_id=qe.workspace_id AND qv.id=qe.quote_version_id JOIN app.quotes q ON q.workspace_id=qv.workspace_id AND q.id=qv.quote_id WHERE fe.workspace_id=$1 AND fe.source_version_id=$2 AND NOT EXISTS(SELECT 1 FROM app.opportunity_threads ot WHERE ot.workspace_id=q.workspace_id AND ot.opportunity_id=q.opportunity_id)`,
      [c.member.workspace_id, id],
    )
  ).rowCount;
  if (detached) throw new BoundaryError(404, '来源关联报价缺少可授权会话');
  const threads = (
    await c.client.query(
      `SELECT DISTINCT ot.thread_id FROM app.fact_evidence fe JOIN app.quote_evidence qe ON qe.workspace_id=fe.workspace_id AND qe.fact_version_id=fe.fact_version_id JOIN app.quote_versions qv ON qv.workspace_id=qe.workspace_id AND qv.id=qe.quote_version_id JOIN app.quotes q ON q.workspace_id=qv.workspace_id AND q.id=qv.quote_id JOIN app.opportunity_threads ot ON ot.workspace_id=q.workspace_id AND ot.opportunity_id=q.opportunity_id WHERE fe.workspace_id=$1 AND fe.source_version_id=$2`,
      [c.member.workspace_id, id],
    )
  ).rows;
  for (const t of threads.sort((a, b) => a.thread_id.localeCompare(b.thread_id)))
    await requireThread(c, t.thread_id, true);
  return v;
}
export async function withdrawSource(c: Context, id: string, reason: string) {
  requireOwner(c);
  const s = await requireSource(c, id);
  if (s.product_id) await lockSupplyProduct(c, s.product_id);
  const v = (
    await c.client.query(
      `UPDATE app.source_versions SET revoked_at=COALESCE(revoked_at,now()),revocation_reason=$1 WHERE workspace_id=$2 AND id=$3 RETURNING *`,
      [reason, c.member.workspace_id, id],
    )
  ).rows[0];
  await c.client.query(
    `UPDATE app.source_documents SET state='withdrawn' WHERE workspace_id=$1 AND id=$2 AND current_version_id=$3`,
    [c.member.workspace_id, s.source_document_id, id],
  );
  await audit(c, 'b.source-withdrawn', id, { reason });
  return v;
}
