import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BoundaryError, requireFactory, databaseNow } from '@zutrade/db';
import type { Context } from '@zutrade/db';
import type { Requirements, QuoteSnapshot } from '@zutrade/contracts';
import { requireThread } from './inbox.js';
import { calculateQuote } from './quote-calculator.js';

export const requirementsSchema = z
  .object({
    productId: z.uuid(),
    quantity: z.string().regex(/^\d{1,12}(\.\d{1,3})?$/),
    unitCode: z.literal('piece'),
    specifications: z
      .object({
        fabric: z.string().max(200),
        dimensions: z.string().max(200),
        color: z.string().max(200),
        printing: z.string().max(200),
      })
      .strict(),
    destination: z.string().max(500),
    purpose: z.string().max(500),
    requestedTiming: z.string().max(500),
    language: z.string().min(1).max(60),
    pendingItems: z.array(z.string().max(500)).max(30),
    internalNote: z.string().max(4000),
  })
  .strict();
export const saveRequirementsSchema = z
  .object({ expectedVersion: z.string().regex(/^[1-9]\d*$/), requirements: requirementsSchema })
  .strict();
export const generateQuoteSchema = z
  .object({
    commandId: z.uuid(),
    expectedVersion: z.string().regex(/^[1-9]\d*$/),
    expectedCurrentVersionId: z.uuid().nullable(),
    discount: z
      .object({
        kind: z.enum(['percent', 'amount']),
        value: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/),
        reason: z.string().trim().min(1).max(500),
      })
      .strict()
      .optional(),
  })
  .strict();
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonicalJSON(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export function canonicalSnapshotHash(value: unknown) {
  return createHash('sha256').update(canonicalJSON(value)).digest('hex');
}
const ws = (c: Context) => c.member.workspace_id;
async function audit(c: Context, action: string, id: string, details: object) {
  await c.client.query(
    `INSERT INTO app.audit_events(workspace_id,actor_member_id,actor_kind,action,aggregate_type,aggregate_id,details) VALUES($1,$2,'member',$3,'quote',$4,$5)`,
    [ws(c), c.member.id, action, id, JSON.stringify(details)],
  );
}
export async function requireOpportunityThreads(c: Context, opportunityId: string, lock = false) {
  const links = (
    await c.client.query(
      'SELECT thread_id FROM app.opportunity_threads WHERE workspace_id=$1 AND opportunity_id=$2 ORDER BY thread_id',
      [ws(c), opportunityId],
    )
  ).rows;
  if (!links.length) throw new BoundaryError(404, '商机缺少可授权会话');
  for (const link of links) await requireThread(c, link.thread_id, lock);
}
async function opportunity(c: Context, threadId: string, id: string, lock = false) {
  await requireThread(c, threadId);
  await requireOpportunityThreads(c, id, true);
  const o = (
    await c.client.query(
      `SELECT o.* FROM app.opportunities o JOIN app.opportunity_threads ot ON ot.workspace_id=o.workspace_id AND ot.opportunity_id=o.id WHERE o.workspace_id=$1 AND o.id=$2 AND ot.thread_id=$3 ${lock ? 'FOR UPDATE OF o' : ''}`,
      [ws(c), id, threadId],
    )
  ).rows[0];
  if (!o) throw new BoundaryError(404, '商机不属于当前会话');
  await requireOpportunityThreads(c, id);
  if (!o.factory_id) throw new BoundaryError(422, '请先由 owner 明确工厂归属');
  await requireFactory(c, o.factory_id);
  return o;
}
export async function saveRequirements(
  c: Context,
  threadId: string,
  id: string,
  input: z.infer<typeof saveRequirementsSchema>,
) {
  const o = await opportunity(c, threadId, id, true);
  if (o.row_version !== input.expectedVersion)
    throw new BoundaryError(409, '需求已被其他成员修改，请重新加载');
  const p = (
    await c.client.query(
      'SELECT id FROM app.products WHERE workspace_id=$1 AND factory_id=$2 AND id=$3',
      [ws(c), o.factory_id, input.requirements.productId],
    )
  ).rows[0];
  if (!p) throw new BoundaryError(422, '产品不属于当前工厂');
  const { internalNote: oldNote, ...old } = o.requirements as Partial<Requirements>;
  const { internalNote: newNote, ...next } = input.requirements;
  void oldNote;
  void newNote;
  const changed = canonicalJSON(old) !== canonicalJSON(next);
  if (canonicalJSON(o.requirements) === canonicalJSON(input.requirements)) return o;
  const result = (
    await c.client.query(
      `UPDATE app.opportunities SET requirements=$3,requirements_revision=requirements_revision+$4 WHERE workspace_id=$1 AND id=$2 RETURNING *`,
      [ws(c), id, JSON.stringify(input.requirements), changed ? 1 : 0],
    )
  ).rows[0];
  await audit(c, 'b.requirements-saved', id, {
    requirementsRevision: result.requirements_revision,
    materialChange: changed,
  });
  return result;
}
export async function quoteAvailability(
  c: Context,
  v: {
    id: string;
    opportunity_id: string;
    requirements_revision: string;
    valid_until: Date | string;
    current_version_id: string;
    factory_id: string;
    state?: string;
    invalidated_at?: Date | string | null;
  },
  now?: Date,
) {
  now ??= await databaseNow(c.client);
  const reasons: string[] = [];
  if ((v.state && v.state !== 'validated') || v.invalidated_at)
    reasons.push('报价版本已失效或尚未完成校验');
  const factory = (
    await c.client.query(
      'SELECT status,authority_valid_until FROM app.factories WHERE workspace_id=$1 AND id=$2',
      [ws(c), v.factory_id],
    )
  ).rows[0];
  if (
    !factory ||
    factory.status !== 'active' ||
    (factory.authority_valid_until && new Date(factory.authority_valid_until) <= now)
  )
    reasons.push('工厂代理授权失效');
  if (v.current_version_id !== v.id) reasons.push('已被新的报价版本替代');
  if (new Date(v.valid_until).getTime() <= now.getTime()) reasons.push('报价已超过固定有效期');
  const o = (
    await c.client.query(
      'SELECT requirements_revision,factory_id FROM app.opportunities WHERE workspace_id=$1 AND id=$2',
      [ws(c), v.opportunity_id],
    )
  ).rows[0];
  if (!o || o.requirements_revision !== v.requirements_revision) reasons.push('采购需求已实质变化');
  if (o?.factory_id !== v.factory_id) reasons.push('商机工厂归属已变化');
  const deps = (
    await c.client.query(
      `SELECT fv.id,fv.state,fv.frozen_at,fv.disclosure,fv.invalidated_at,fv.valid_from,fv.valid_until,f.current_version_id,
 sv.id AS source_id,sv.revoked_at,sv.valid_until AS source_until,sd.state AS source_state,sd.current_version_id AS current_source,
 pr.id AS price_id,pr.valid_from AS price_from,pr.valid_until AS price_until
 FROM app.quote_evidence qe JOIN app.fact_versions fv ON fv.workspace_id=qe.workspace_id AND fv.id=qe.fact_version_id JOIN app.facts f ON f.workspace_id=fv.workspace_id AND f.id=fv.fact_id LEFT JOIN app.fact_evidence fe ON fe.workspace_id=fv.workspace_id AND fe.fact_version_id=fv.id LEFT JOIN app.source_versions sv ON sv.workspace_id=fe.workspace_id AND sv.id=fe.source_version_id LEFT JOIN app.source_documents sd ON sd.workspace_id=sv.workspace_id AND sd.id=sv.source_document_id LEFT JOIN app.price_rules pr ON pr.workspace_id=fv.workspace_id AND pr.fact_version_id=fv.id WHERE qe.workspace_id=$1 AND qe.quote_version_id=$2`,
      [ws(c), v.id],
    )
  ).rows;
  if (!deps.length) reasons.push('报价缺少有效证据');
  for (const d of deps) {
    if (
      d.state !== 'published' ||
      !d.frozen_at ||
      d.invalidated_at ||
      d.disclosure !== 'buyer_visible' ||
      d.current_version_id !== d.id
    )
      reasons.push('供给事实已撤回、失效或被替代');
    if (
      (d.valid_from && new Date(d.valid_from) > now) ||
      (d.valid_until && new Date(d.valid_until) <= now)
    )
      reasons.push('供给事实不在有效期');
    if (
      !d.source_id ||
      d.revoked_at ||
      d.source_state !== 'active' ||
      d.current_source !== d.source_id ||
      (d.source_until && new Date(d.source_until) <= now)
    )
      reasons.push('来源资料已撤回、过期或被替代');
    if (
      !d.price_id ||
      new Date(d.price_from) > now ||
      (d.price_until && new Date(d.price_until) <= now)
    )
      reasons.push('价阶不在有效期');
  }
  return { available: reasons.length === 0, reasons: [...new Set(reasons)] };
}
export async function requireQuoteVersion(c: Context, id: string) {
  const v = (
    await c.client.query(
      `SELECT v.*,q.opportunity_id,q.current_version_id,q.quote_number FROM app.quote_versions v JOIN app.quotes q ON q.workspace_id=v.workspace_id AND q.id=v.quote_id WHERE v.workspace_id=$1 AND v.id=$2`,
      [ws(c), id],
    )
  ).rows[0];
  if (!v) throw new BoundaryError(404, '报价版本不存在或未获授权');
  await requireFactory(c, v.factory_id);
  await requireOpportunityThreads(c, v.opportunity_id, true);
  await c.client.query(
    'SELECT id FROM app.opportunities WHERE workspace_id=$1 AND id=$2 FOR SHARE',
    [ws(c), v.opportunity_id],
  );
  const snapshot = v.terms_snapshot.snapshot as QuoteSnapshot | undefined;
  if (snapshot)
    await c.client.query(`SELECT pg_advisory_xact_lock(hashtextextended('b-product:'||$1,0))`, [
      snapshot.requirements.productId,
    ]);
  if (!snapshot || canonicalSnapshotHash(snapshot) !== v.snapshot_sha256)
    throw new BoundaryError(409, '冻结报价快照摘要不匹配');
  v.current_version_id = (
    await c.client.query(
      'SELECT current_version_id FROM app.quotes WHERE workspace_id=$1 AND id=$2',
      [ws(c), v.quote_id],
    )
  ).rows[0]?.current_version_id;
  return { ...v, snapshot, availability: await quoteAvailability(c, v) };
}
export async function quotingWorkspace(c: Context, threadId: string) {
  await requireThread(c, threadId);
  const opportunities = (
    await c.client.query(
      `SELECT o.* FROM app.opportunities o JOIN app.opportunity_threads ot ON ot.workspace_id=o.workspace_id AND ot.opportunity_id=o.id WHERE ot.workspace_id=$1 AND ot.thread_id=$2 ORDER BY o.created_at,o.id`,
      [ws(c), threadId],
    )
  ).rows;
  const products = [];
  for (const o of opportunities) {
    await requireOpportunityThreads(c, o.id);
    if (o.factory_id) {
      await requireFactory(c, o.factory_id);
      products.push(
        ...(
          await c.client.query(
            "SELECT id,name,sku,factory_id,configuration_schema FROM app.products WHERE workspace_id=$1 AND factory_id=$2 AND state='active' ORDER BY sku",
            [ws(c), o.factory_id],
          )
        ).rows,
      );
    }
    const quotes = (
      await c.client.query(
        'SELECT id,current_version_id FROM app.quotes WHERE workspace_id=$1 AND opportunity_id=$2 ORDER BY created_at,id',
        [ws(c), o.id],
      )
    ).rows;
    o.quote = quotes.at(-1) ?? null;
    o.pendingItems =
      (
        await c.client.query(
          `SELECT details->'reasons' AS reasons FROM app.audit_events WHERE workspace_id=$1 AND aggregate_id=$2 AND action='b.quote-blocked' AND details->>'requirementsRevision'=$3 AND occurred_at>COALESCE((SELECT max(v.created_at) FROM app.quote_versions v JOIN app.quotes q ON q.workspace_id=v.workspace_id AND q.id=v.quote_id WHERE q.workspace_id=$1 AND q.opportunity_id=$2),'-infinity'::timestamptz) ORDER BY occurred_at DESC,id DESC LIMIT 1`,
          [ws(c), o.id, o.requirements_revision],
        )
      ).rows[0]?.reasons ?? [];
    o.versions = [];
    for (const q of quotes) {
      const versions = (
        await c.client.query(
          `SELECT v.id,v.version_no,v.total_amount,v.created_at,v.valid_until,v.requirements_revision,v.factory_id,q.opportunity_id,q.current_version_id,a.state AS pdf_state,a.error_code AS pdf_error FROM app.quote_versions v JOIN app.quotes q ON q.workspace_id=v.workspace_id AND q.id=v.quote_id LEFT JOIN app.quote_pdf_artifacts a ON a.workspace_id=v.workspace_id AND a.quote_version_id=v.id WHERE v.workspace_id=$1 AND v.quote_id=$2 ORDER BY v.version_no DESC`,
          [ws(c), q.id],
        )
      ).rows;
      for (const v of versions)
        o.versions.push({
          ...v,
          availability: (await requireQuoteVersion(c, v.id)).availability,
          pdf: { state: v.pdf_state ?? 'pending', last_error: v.pdf_error },
        });
    }
  }
  return { opportunities, products: [...new Map(products.map((p) => [p.id, p])).values()] };
}
export async function quoteVersionDetail(c: Context, id: string) {
  const v = await requireQuoteVersion(c, id);
  const pdf = (
    await c.client.query(
      'SELECT state,error_code AS last_error,pdf_sha256 AS content_sha256,byte_length AS content_size,template_version FROM app.quote_pdf_artifacts WHERE workspace_id=$1 AND quote_version_id=$2',
      [ws(c), id],
    )
  ).rows[0] ?? { state: 'pending' };
  return { ...v, total_amount: v.snapshot.totalAmount, pdf };
}
export async function generateQuote(
  c: Context,
  threadId: string,
  opportunityId: string,
  input: z.infer<typeof generateQuoteSchema>,
  now?: Date,
) {
  await c.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `${ws(c)}:b-quote:${input.commandId}`,
  ]);
  const commandHash = canonicalSnapshotHash({ threadId, opportunityId, ...input });
  const previous = (
    await c.client.query(
      'SELECT id,command_sha256 FROM app.quote_versions WHERE workspace_id=$1 AND command_id=$2',
      [ws(c), input.commandId],
    )
  ).rows[0];
  if (previous) {
    if (previous.command_sha256 !== commandHash)
      throw new BoundaryError(409, '相同报价命令对应了不同内容');
    return quoteVersionDetail(c, previous.id);
  }
  const o = await opportunity(c, threadId, opportunityId, true);
  now ??= await databaseNow(c.client);
  if (o.row_version !== input.expectedVersion)
    throw new BoundaryError(409, '需求版本已过期，请重新加载');
  const parsed = requirementsSchema.safeParse(o.requirements);
  if (!parsed.success) return blocked(c, o.id, ['请先补齐产品、数量、规格和结构化采购需求']);
  const req = parsed.data;
  const factory = (
    await c.client.query(
      'SELECT status,authority_valid_until FROM app.factories WHERE workspace_id=$1 AND id=$2',
      [ws(c), o.factory_id],
    )
  ).rows[0];
  if (
    !factory ||
    factory.status !== 'active' ||
    (factory.authority_valid_until && new Date(factory.authority_valid_until) <= now)
  )
    return blocked(c, o.id, ['工厂代理授权失效']);
  await c.client.query(`SELECT pg_advisory_xact_lock(hashtextextended('b-product:'||$1,0))`, [
    req.productId,
  ]);
  const product = (
    await c.client.query(
      `SELECT * FROM app.products WHERE workspace_id=$1 AND factory_id=$2 AND id=$3 AND state='active'`,
      [ws(c), o.factory_id, req.productId],
    )
  ).rows[0];
  if (!product) return blocked(c, o.id, ['当前产品不可用于此工厂报价']);
  if (!/^\d{1,12}$/.test(req.quantity) || BigInt(req.quantity) <= 0n)
    return blocked(c, o.id, ['CT-01 按整件采购，数量必须为正整数']);
  if (Object.values(req.specifications).some((v) => !v.trim()))
    return blocked(c, o.id, ['缺少关键产品规格']);
  const thread = await requireThread(c, threadId);
  const recipient = (
    await c.client.query(
      `SELECT cp.id,cp.buyer_id,cp.contact_id,cp.normalized_value,c.display_name,b.name AS buyer_name,c.buyer_id AS contact_buyer_id FROM app.contact_points cp JOIN app.contacts c ON c.workspace_id=cp.workspace_id AND c.id=cp.contact_id JOIN app.buyers b ON b.workspace_id=cp.workspace_id AND b.id=cp.buyer_id WHERE cp.workspace_id=$1 AND cp.id=$2`,
      [ws(c), thread.primary_contact_point_id],
    )
  ).rows[0];
  if (
    !recipient ||
    recipient.buyer_id !== o.buyer_id ||
    recipient.contact_buyer_id !== o.buyer_id ||
    recipient.contact_id !== o.primary_contact_id
  )
    throw new BoundaryError(409, '买家、联系人、商机与会话收件关系不一致');
  const rules = (
    await c.client.query(
      `SELECT p.*,v.value,v.applicability,v.valid_until AS fact_until,v.valid_from AS fact_from,v.verified_by_member_id,v.verified_at FROM app.price_rules p JOIN app.fact_versions v ON v.workspace_id=p.workspace_id AND v.id=p.fact_version_id JOIN app.facts f ON f.workspace_id=v.workspace_id AND f.id=v.fact_id WHERE p.workspace_id=$1 AND p.factory_id=$2 AND p.product_id=$3 AND p.unit_code=$4 AND p.currency_code='USD' AND p.qty_min<=$5::numeric AND (p.qty_max IS NULL OR p.qty_max>$5::numeric) AND p.valid_from<=$6 AND (p.valid_until IS NULL OR p.valid_until>$6) AND v.state='published' AND v.frozen_at IS NOT NULL AND v.disclosure='buyer_visible' AND v.invalidated_at IS NULL AND f.current_version_id=v.id AND (v.valid_from IS NULL OR v.valid_from<=$6) AND (v.valid_until IS NULL OR v.valid_until>$6)`,
      [ws(c), o.factory_id, req.productId, req.unitCode, req.quantity, now],
    )
  ).rows.filter(
    (p) =>
      canonicalJSON(p.value.specifications) === canonicalJSON(req.specifications) &&
      Object.entries(p.applicability).every(
        ([k, v]) =>
          (req as unknown as Record<string, unknown>)[k] === v ||
          (req.specifications as unknown as Record<string, unknown>)[k] === v,
      ),
  );
  if (rules.length !== 1)
    return blocked(c, o.id, [
      rules.length
        ? '存在歧义价阶，须由 owner 重新确认'
        : '没有适用的已确认有效价阶、单位或规格依据',
    ]);
  const rule = rules[0];
  const evidence = (
    await c.client.query(
      `SELECT e.*,s.content_sha256,s.valid_until,s.revoked_at,d.state,d.current_version_id FROM app.fact_evidence e JOIN app.source_versions s ON s.workspace_id=e.workspace_id AND s.id=e.source_version_id JOIN app.source_documents d ON d.workspace_id=s.workspace_id AND d.id=s.source_document_id WHERE e.workspace_id=$1 AND e.fact_version_id=$2 ORDER BY e.id`,
      [ws(c), rule.fact_version_id],
    )
  ).rows;
  if (
    !evidence.length ||
    evidence.some(
      (e) =>
        e.factory_id !== o.factory_id ||
        !e.locator ||
        !e.excerpt ||
        e.revoked_at ||
        e.state !== 'active' ||
        e.current_version_id !== e.source_version_id ||
        (e.valid_until && new Date(e.valid_until) <= now),
    )
  )
    return blocked(c, o.id, ['来源依据缺失、跨工厂、撤回、过期或被替代']);
  const calc = calculateQuote({
    quantity: req.quantity,
    unitCode: req.unitCode,
    currency: 'USD',
    rule: {
      qtyMin: rule.qty_min,
      qtyMax: rule.qty_max,
      unitCode: rule.unit_code,
      currency: rule.currency_code,
      unitPrice: rule.unit_price,
      setupFee: rule.setup_fee,
    },
    maxDiscountPercent: rule.value.discountBoundary.maxPercent,
    ...(input.discount ? { discount: input.discount } : {}),
  });
  if (calc.discountProposal) {
    await audit(c, 'b.discount-proposed', o.id, {
      proposal: calc.discountProposal,
      requirementsRevision: o.requirements_revision,
    });
    return blocked(c, o.id, ['折扣超出 owner 已发布边界，已保存待核验提案']);
  }
  const existing = (
    await c.client.query(
      'SELECT * FROM app.quotes WHERE workspace_id=$1 AND opportunity_id=$2 ORDER BY created_at,id FOR UPDATE',
      [ws(c), o.id],
    )
  ).rows;
  if (existing.length > 1) throw new BoundaryError(409, '商机存在多个报价身份，请明确后再生成');
  let quote = existing[0];
  if ((quote?.current_version_id ?? null) !== input.expectedCurrentVersionId)
    throw new BoundaryError(409, '另一成员已生成新报价，请先核对版本历史');
  if (quote && quote.factory_id !== o.factory_id)
    throw new BoundaryError(409, '报价身份固定，工厂重新归属须建立新业务对象');
  if (!quote)
    quote = (
      await c.client.query(
        `INSERT INTO app.quotes(workspace_id,factory_id,opportunity_id,buyer_id,quote_number,created_by_member_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          ws(c),
          o.factory_id,
          o.id,
          o.buyer_id,
          `ZT-${randomUUID().slice(0, 8).toUpperCase()}`,
          c.member.id,
        ],
      )
    ).rows[0];
  const next = (
    await c.client.query(
      'SELECT COALESCE(max(version_no),0)+1 AS next FROM app.quote_versions WHERE workspace_id=$1 AND quote_id=$2',
      [ws(c), quote.id],
    )
  ).rows[0].next as number;
  const defaultUntil = now.getTime() + 7 * 86400000;
  const dates = [
    factory.authority_valid_until,
    rule.valid_until,
    rule.fact_until,
    ...evidence.map((e) => e.valid_until),
  ]
    .filter(Boolean)
    .map((v) => new Date(v).getTime());
  const actualUntil = Math.min(defaultUntil, ...dates);
  const validityReasons =
    actualUntil < defaultUntil
      ? [
          'Validity shortened to the earliest expiry of the confirmed price, fact, source or factory authorization.',
        ]
      : ['Valid for seven days from issue time.'];
  const { internalNote, ...publicReq } = req;
  void internalNote;
  const snapshot: QuoteSnapshot = {
    schemaVersion: 'b-quote-v1',
    quoteNumber: quote.quote_number,
    version: next,
    createdAt: now.toISOString(),
    simulation: true,
    seller: { name: rule.value.seller.name, agent: 'ZuTrade' },
    buyer: {
      name: recipient.buyer_name,
      contactName: recipient.display_name,
      channelIdentity: recipient.normalized_value,
    },
    requirements: publicReq,
    lines: calc.lines.map((l) =>
      l.kind === 'product'
        ? { ...l, description: `${product.sku} ${product.name} (simulation)` }
        : l,
    ),
    currency: 'USD',
    currencyScale: calc.currencyScale,
    roundingPolicy: calc.roundingPolicy,
    calculationVersion: calc.calculationVersion,
    totalAmount: calc.totalAmount,
    discount: input.discount
      ? { kind: input.discount.kind, value: input.discount.value, basis: 'product_subtotal' }
      : null,
    scope: 'product_only',
    exclusions: rule.value.exclusions,
    pendingItems: [
      ...req.pendingItems,
      'Shipping, taxes and sample price require a separate quotation.',
      'Arrival within six weeks is not committed.',
      'Payment terms require confirmation.',
    ],
    production: rule.value.production,
    paymentTerms: null,
    sampleTerms: rule.value.sampleTerms,
    committedArrivalDate: null,
    validUntil: new Date(actualUntil).toISOString(),
    timeZone: 'Asia/Shanghai',
    validityReasons,
    evidence: evidence.map((e) => ({
      factVersionId: rule.fact_version_id,
      priceRuleId: rule.id,
      sourceVersionId: e.source_version_id,
      locator: e.locator,
      excerpt: e.excerpt,
      sourceSha256: e.content_sha256,
    })),
  };
  const digest = canonicalSnapshotHash(snapshot);
  const version = (
    await c.client.query(
      `INSERT INTO app.quote_versions(workspace_id,factory_id,quote_id,version_no,requirements_revision,currency_code,currency_scale,total_amount,rounding_policy,calculation_version,seller_snapshot,buyer_snapshot,scope,shipping_scope,tax_scope,payment_terms,sample_terms,production_days,production_day_kind,production_start_conditions,committed_arrival_date,terms_snapshot,valid_until,validity_time_zone,created_by_member_id,command_id,command_sha256) VALUES($1,$2,$3,$4,$5,'USD',2,$6,'half_up_per_line','b-calc-v1',$7,$8,'product_only','excluded','excluded',NULL,$9,$10,$11,$12,NULL,$13,$14,'Asia/Shanghai',$15,$16,$17) RETURNING *`,
      [
        ws(c),
        o.factory_id,
        quote.id,
        next,
        o.requirements_revision,
        calc.totalAmount,
        JSON.stringify(snapshot.seller),
        JSON.stringify(snapshot.buyer),
        snapshot.sampleTerms,
        snapshot.production.days,
        snapshot.production.dayKind,
        snapshot.production.startConditions,
        JSON.stringify({ snapshot }),
        snapshot.validUntil,
        c.member.id,
        input.commandId,
        commandHash,
      ],
    )
  ).rows[0];
  for (const [position, line] of snapshot.lines.entries())
    await c.client.query(
      `INSERT INTO app.quote_lines(workspace_id,factory_id,quote_version_id,position,line_kind,product_id,price_rule_id,description,specification_snapshot,quantity,unit_code,unit_price,line_amount) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        ws(c),
        o.factory_id,
        version.id,
        position,
        line.kind,
        line.kind === 'product' ? product.id : null,
        line.kind === 'product' ? rule.id : null,
        line.description,
        JSON.stringify(req.specifications),
        line.quantity,
        line.unitCode,
        line.unitPrice,
        line.amount,
      ],
    );
  await c.client.query(
    `INSERT INTO app.quote_evidence(workspace_id,factory_id,quote_version_id,fact_version_id,usage_key) VALUES($1,$2,$3,$4,'price_and_supply')`,
    [ws(c), o.factory_id, version.id, rule.fact_version_id],
  );
  await c.client.query(
    `UPDATE app.quote_versions SET state='validated',snapshot_sha256=$3,frozen_at=$4 WHERE workspace_id=$1 AND id=$2`,
    [ws(c), version.id, digest, now],
  );
  await c.client.query(
    `UPDATE app.quotes SET current_version_id=$3 WHERE workspace_id=$1 AND id=$2`,
    [ws(c), quote.id, version.id],
  );
  await c.client.query(
    `INSERT INTO app.quote_pdf_artifacts(workspace_id,factory_id,quote_version_id,snapshot_sha256,template_version,created_by_member_id) VALUES($1,$2,$3,$4,'quote-pdf.v1',$5)`,
    [ws(c), o.factory_id, version.id, digest, c.member.id],
  );
  await audit(c, 'b.quote-validated', version.id, {
    snapshotSha256: digest,
    requirementsRevision: o.requirements_revision,
    approval: 'not_requested',
    internalDiscountReason: input.discount?.reason ?? null,
  });
  return quoteVersionDetail(c, version.id);
}
async function blocked(c: Context, id: string, reasons: string[]) {
  const revision = (
    await c.client.query(
      'SELECT requirements_revision FROM app.opportunities WHERE workspace_id=$1 AND id=$2',
      [ws(c), id],
    )
  ).rows[0]?.requirements_revision;
  await audit(c, 'b.quote-blocked', id, { reasons, requirementsRevision: revision });
  return { blocked: true, pendingItems: reasons };
}
