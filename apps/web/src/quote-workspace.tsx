import { ApprovalPanel } from './approvals';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, FileText, RefreshCw } from 'lucide-react';
import type { MemberView, QuoteSnapshot, Requirements } from '@zutrade/contracts';
import { Button } from '@zutrade/ui';
import { commerceDate, commerceDecimal, commerceRequest } from './commerce-api';

interface Availability {
  available: boolean;
  reasons: string[];
}
interface PdfManifest {
  state: string;
  error_code: string | null;
  content_sha256?: string | null;
  pdf_sha256?: string | null;
}
interface Version {
  id: string;
  version_no: number;
  total_amount: string;
  created_at: string;
  valid_until: string;
  availability: Availability;
  pdf: PdfManifest | null;
}
interface Opportunity {
  id: string;
  factory_id: string | null;
  title: string;
  row_version: string;
  requirements_revision: string;
  requirements: Partial<Requirements>;
  pendingItems?: string[];
  quote: { id: string; current_version_id: string | null } | null;
  versions: Version[];
}
interface Product {
  id: string;
  factory_id: string;
  sku: string;
  name: string;
  configuration_schema: Record<string, unknown>;
}
interface Workspace {
  opportunities: Opportunity[];
  products: Product[];
}
interface VersionDetail {
  id: string;
  snapshot: QuoteSnapshot;
  availability: Availability;
  pdf: PdfManifest | null;
}
export function QuoteWorkspace({
  member,
  threadId,
  contextRevision,
}: {
  member: MemberView;
  threadId: string;
  contextRevision: string;
}) {
  const cache = useQueryClient();
  const base = `/api/workspaces/${member.workspace_id}/quoting`;
  const key = ['quoting', member.id, threadId];
  const [selectedOpportunity, setSelectedOpportunity] = useState('');
  const [selectedVersion, setSelectedVersion] = useState('');
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generationCommand = useRef<{ fingerprint: string; commandId: string } | null>(null);
  const workspace = useQuery({
    queryKey: key,
    queryFn: () => commerceRequest<Workspace>(`${base}/threads/${threadId}`),
    retry: false,
    refetchInterval: 5000,
  });
  const opportunity =
    workspace.data?.opportunities.find((o) => o.id === selectedOpportunity) ??
    workspace.data?.opportunities[0];
  const versionId = selectedVersion || opportunity?.quote?.current_version_id;
  const version = useQuery({
    queryKey: [...key, 'version', versionId],
    queryFn: () => commerceRequest<VersionDetail>(`${base}/versions/${versionId}`),
    enabled: Boolean(versionId),
    retry: false,
    refetchInterval: 3000,
  });
  async function mutate<T>(name: string, path: string, body: unknown, after?: (data: T) => void) {
    setPending(name);
    setError('');
    setNotice('');
    try {
      const result = await commerceRequest<T>(path, body);
      after?.(result);
      await cache.invalidateQueries({ queryKey: key });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
      await cache.invalidateQueries({ queryKey: key });
      return false;
    } finally {
      setPending('');
    }
  }
  async function saveRequirements(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!opportunity) return;
    const form = new FormData(e.currentTarget);
    const requirements: Requirements = {
      productId: String(form.get('productId')),
      quantity: String(form.get('quantity')),
      unitCode: 'piece',
      specifications: {
        fabric: String(form.get('fabric')),
        dimensions: String(form.get('dimensions')),
        color: String(form.get('color')),
        printing: String(form.get('printing')),
      },
      destination: String(form.get('destination')),
      purpose: String(form.get('purpose')),
      requestedTiming: String(form.get('requestedTiming')),
      language: String(form.get('language')),
      pendingItems: String(form.get('pendingItems'))
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      internalNote: String(form.get('internalNote')),
    };
    await mutate(
      'requirements',
      `${base}/threads/${threadId}/opportunities/${opportunity.id}/requirements`,
      { expectedVersion: opportunity.row_version, requirements },
      () => {
        setDirty(false);
        setEditing(false);
        setNotice('需求已保存。实质变更后的旧报价将显示待重核原因。');
      },
    );
  }
  async function generate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!opportunity) return;
    const form = new FormData(e.currentTarget);
    const discountKind = form.get('discountKind');
    const body = {
      expectedVersion: opportunity.row_version,
      expectedCurrentVersionId: opportunity.quote?.current_version_id ?? null,
      ...(discountKind
        ? {
            discount: {
              kind: discountKind,
              value: String(form.get('discountValue')),
              reason: String(form.get('discountReason')),
            },
          }
        : {}),
    };
    const fingerprint = JSON.stringify({ opportunityId: opportunity.id, ...body });
    if (generationCommand.current?.fingerprint !== fingerprint)
      generationCommand.current = { fingerprint, commandId: crypto.randomUUID() };
    await mutate<{ id?: string; blocked?: boolean; pendingItems?: string[] }>(
      'generate',
      `${base}/threads/${threadId}/opportunities/${opportunity.id}/versions`,
      { ...body, commandId: generationCommand.current.commandId },
      (result) => {
        if (result.blocked) {
          setError(
            `报价尚不完整：${result.pendingItems?.join('；') ?? '请补齐已确认的供给依据'}。待确认项已保存。`,
          );
          return;
        }
        if (result.id) setSelectedVersion(result.id);
        setNotice('报价已校验并冻结为内部预览；可单独生成此版本 PDF。');
      },
    );
  }
  const r = opportunity?.requirements;
  const products =
    workspace.data?.products.filter((p) => p.factory_id === opportunity?.factory_id) ?? [];
  const pdf = version.data?.pdf;
  return (
    <section className="quote-workspace" aria-label="采购需求与内部报价">
      <div className="quote-workspace-header">
        <h3>采购需求与内部报价</h3>
        <button
          className="text-button"
          onClick={() => void cache.invalidateQueries({ queryKey: key })}
        >
          <RefreshCw size={12} /> 刷新依据
        </button>
      </div>
      <p className="team-caption">
        仅团队可见。报价校验完成与供给确认均不代表外发审批；最终内容须由指定 owner
        审批后才能模拟执行。
      </p>
      {workspace.isPending ? (
        <p className="commerce-empty">正在读取采购需求…</p>
      ) : workspace.isError ? (
        <div className="commerce-error" role="alert">
          {workspace.error.message}
          <button className="text-button" onClick={() => void workspace.refetch()}>
            重试
          </button>
        </div>
      ) : !opportunity ? (
        <p className="commerce-empty">此会话尚无采购商机，请先由 owner 分配归属工厂。</p>
      ) : (
        <>
          {workspace.data.opportunities.length > 1 && (
            <div className="commerce-toolbar">
              <label>
                采购商机
                <select
                  aria-label="采购商机"
                  value={opportunity.id}
                  onChange={(e) => {
                    setSelectedOpportunity(e.target.value);
                    setSelectedVersion('');
                    setEditing(false);
                    setDirty(false);
                  }}
                >
                  {workspace.data.opportunities.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {!opportunity.factory_id && (
            <p className="commerce-notice">
              需求尚未明确工厂。请由 owner 在会话资料中分配，再生成报价。
            </p>
          )}
          {Boolean(opportunity.pendingItems?.length) && (
            <div className="commerce-notice" aria-label="已保存的待确认项">
              待确认事项：{opportunity.pendingItems?.join('；')}
            </div>
          )}
          {error && (
            <p className="commerce-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="commerce-notice" role="status">
              {notice}
            </p>
          )}
          <div className="commerce-card">
            <div className="commerce-card-heading">
              <div>
                <strong>
                  {r?.quantity
                    ? `${r.quantity} piece · ${products.find((p) => p.id === r.productId)?.sku ?? '产品待确认'}`
                    : '采购需求待整理'}
                </strong>
                <p>
                  需求修订 {opportunity.requirements_revision} · 对象版本 {opportunity.row_version}
                </p>
              </div>
              <button
                className="text-button"
                onClick={() => setEditing(!editing)}
                aria-expanded={editing}
              >
                {editing ? '收起需求' : r?.quantity ? '编辑需求' : '整理采购需求'}{' '}
                <ChevronDown size={13} />
              </button>
            </div>
            {!editing && r?.quantity && (
              <>
                <p>
                  {r.specifications?.fabric} · {r.specifications?.dimensions} ·{' '}
                  {r.specifications?.color} · {r.specifications?.printing}
                </p>
                <p>
                  目的地：{r.destination || '待确认'} · 用途：{r.purpose || '待确认'}
                </p>
                <p>买家原始时间要求：{r.requestedTiming || '未提供'}（不作为到货承诺）</p>
              </>
            )}
            {editing && (
              <form
                key={`${opportunity.id}:${opportunity.row_version}`}
                className="commerce-form commerce-detail"
                onSubmit={(e) => void saveRequirements(e)}
                onChange={() => setDirty(true)}
              >
                <label>
                  产品
                  <select
                    name="productId"
                    aria-label="产品"
                    required
                    defaultValue={r?.productId ?? ''}
                  >
                    <option value="" disabled>
                      选择本商机工厂产品
                    </option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.sku} · {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  数量（piece / 整件）
                  <input
                    name="quantity"
                    aria-label="采购数量"
                    inputMode="numeric"
                    pattern="[0-9]+"
                    defaultValue={r?.quantity ?? ''}
                    required
                    maxLength={12}
                  />
                </label>
                <label>
                  面料
                  <input
                    name="fabric"
                    defaultValue={r?.specifications?.fabric ?? ''}
                    placeholder="12oz"
                    required
                    maxLength={1000}
                  />
                </label>
                <label>
                  尺寸
                  <input
                    name="dimensions"
                    defaultValue={r?.specifications?.dimensions ?? ''}
                    placeholder="35×40cm"
                    required
                    maxLength={1000}
                  />
                </label>
                <label>
                  颜色
                  <input
                    name="color"
                    defaultValue={r?.specifications?.color ?? ''}
                    placeholder="Natural"
                    required
                    maxLength={1000}
                  />
                </label>
                <label>
                  印刷配置
                  <input
                    name="printing"
                    defaultValue={r?.specifications?.printing ?? ''}
                    placeholder="Single colour / single side logo"
                    required
                    maxLength={1000}
                  />
                </label>
                <label>
                  目的地
                  <input name="destination" defaultValue={r?.destination ?? ''} maxLength={1000} />
                </label>
                <label>
                  用途
                  <input name="purpose" defaultValue={r?.purpose ?? ''} maxLength={1000} />
                </label>
                <label className="wide">
                  买家要求日期 / 原始时间要求
                  <input
                    name="requestedTiming"
                    defaultValue={r?.requestedTiming ?? ''}
                    placeholder="例如 Arrive in six weeks（仅为买家要求）"
                    maxLength={1000}
                  />
                </label>
                <label>
                  买家语言
                  <select name="language" defaultValue={r?.language ?? 'en'}>
                    <option value="en">English</option>
                    <option value="zh">中文</option>
                  </select>
                </label>
                <label>
                  待确认项（每行一项）
                  <textarea
                    name="pendingItems"
                    defaultValue={r?.pendingItems?.join('\n') ?? ''}
                    maxLength={12000}
                  />
                </label>
                <label className="wide">
                  内部备注（不进入预览或 PDF）
                  <textarea
                    name="internalNote"
                    defaultValue={r?.internalNote ?? ''}
                    maxLength={4000}
                  />
                </label>
                <p className="wide form-help">
                  数量、规格等实质变化会推进需求修订。内部备注或不变的保存不会无故使报价失效。
                </p>
                <Button disabled={Boolean(pending) || !opportunity.factory_id}>
                  {pending === 'requirements' ? '正在保存…' : '保存采购需求'}
                </Button>
              </form>
            )}
          </div>
          <form className="commerce-form" onSubmit={(e) => void generate(e)}>
            <details className="wide commerce-detail">
              <summary>折扣提案（默认无折扣）</summary>
              <div className="commerce-form">
                <label>
                  折扣方式
                  <select name="discountKind" defaultValue="">
                    <option value="">不申请折扣</option>
                    <option value="percent">产品小计百分比</option>
                    <option value="amount">USD 固定金额</option>
                  </select>
                </label>
                <label>
                  折扣数值
                  <input
                    name="discountValue"
                    inputMode="decimal"
                    placeholder="选择折扣后填写"
                    maxLength={20}
                  />
                </label>
                <label className="wide">
                  折扣理由
                  <input name="discountReason" maxLength={1000} />
                </label>
                <p className="form-help wide">
                  超出 owner 已发布边界的折扣保留为待核验提案，不擅自更改原始单价。外发仍须审批。
                </p>
              </div>
            </details>
            <Button
              type="submit"
              disabled={Boolean(pending) || dirty || !r?.quantity || !opportunity.factory_id}
            >
              {pending === 'generate' ? '正在校验并冻结…' : '生成内部报价预览'}
            </Button>
            {dirty && <p className="form-help wide">需求有未保存的修改，请先保存后生成。</p>}
          </form>
          {opportunity.versions.length > 0 && (
            <>
              <div className="quote-version-tabs" aria-label="报价版本历史">
                {opportunity.versions.map((v) => (
                  <button
                    key={v.id}
                    className={v.id === versionId ? 'selected' : ''}
                    onClick={() => setSelectedVersion(v.id)}
                  >
                    v{v.version_no} · USD {commerceDecimal(v.total_amount, 2)}
                    {!v.availability.available ? ' · 待重核' : ''}
                  </button>
                ))}
              </div>
              {version.isPending ? (
                <p className="commerce-empty">正在读取冻结报价…</p>
              ) : version.isError ? (
                <p className="commerce-error" role="alert">
                  {version.error.message}
                </p>
              ) : (
                version.data && (
                  <>
                    <div className="commerce-badges">
                      <span
                        className={`commerce-status ${version.data.availability.available ? '' : 'warning'}`}
                      >
                        {version.data.availability.available ? '报价已校验' : '报价需要重核'}
                      </span>
                      <span className="commerce-status warning">尚未获得外发审批</span>
                      <span className="simulation-tag">模拟供给 · 内部预览</span>
                    </div>
                    {!version.data.availability.available && (
                      <div className="commerce-error" role="alert">
                        {version.data.availability.reasons.map((reason, index) => (
                          <p key={index}>{reason}</p>
                        ))}
                        历史金额、条款和文件仍保留；需核对依据并生成新版本。
                      </div>
                    )}
                    <div className="quote-summary">
                      <span>冻结版本 v{version.data.snapshot.version} · product_only</span>
                      <strong>USD {version.data.snapshot.totalAmount}</strong>
                    </div>
                    <QuotePreview snapshot={version.data.snapshot} />
                    <div className="quote-pdf-status">
                      <FileText size={15} />
                      <span>
                        {pdf?.state === 'ready'
                          ? 'PDF 已就绪'
                          : pdf?.state === 'failed'
                            ? 'PDF 生成失败'
                            : pdf?.state === 'generating'
                              ? 'PDF 正在生成'
                              : 'PDF 尚未生成'}
                      </span>
                      {pdf?.state === 'ready' && (
                        <a
                          href={`${base}/versions/${versionId}/pdf`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          下载此版本 PDF
                        </a>
                      )}
                      {(pdf?.state === 'pending' ||
                        !pdf ||
                        (pdf.state === 'failed' &&
                          pdf.error_code !== 'PDF_OBJECT_UNAVAILABLE')) && (
                        <Button
                          variant="outline"
                          disabled={Boolean(pending)}
                          onClick={() =>
                            void mutate('pdf', `${base}/versions/${versionId}/pdf`, {})
                          }
                        >
                          {pending === 'pdf'
                            ? '正在生成…'
                            : pdf?.state === 'failed'
                              ? '重试 PDF 生成'
                              : '生成此版本 PDF'}
                        </Button>
                      )}
                      {pdf?.error_code === 'PDF_OBJECT_UNAVAILABLE' && (
                        <p className="commerce-error">
                          已保存的 PDF
                          文件缺失或损坏，请恢复原始文件后刷新检查；历史产物不会被重新渲染替换。
                        </p>
                      )}
                      {pdf?.error_code && (
                        <p className="commerce-error" role="alert">
                          {pdf.error_code}
                        </p>
                      )}
                      {(pdf?.content_sha256 || pdf?.pdf_sha256) && (
                        <code>PDF 字节 SHA256 {pdf.content_sha256 ?? pdf.pdf_sha256}</code>
                      )}
                    </div>
                    <details className="commerce-detail">
                      <summary>冻结依据与版本信息</summary>
                      <p className="team-caption">
                        此处与英文预览均读取该版本冻结快照。有效期：
                        {commerceDate(version.data.snapshot.validUntil)} ·{' '}
                        {version.data.snapshot.timeZone}
                      </p>
                      {version.data.snapshot.validityReasons.map((reason, i) => (
                        <p className="team-caption" key={i}>
                          {reason}
                        </p>
                      ))}
                      {version.data.snapshot.evidence.map((e, i) => (
                        <article className="quote-evidence" key={i}>
                          事实 {e.factVersionId} · 价阶 {e.priceRuleId}
                          <br />
                          来源版本 {e.sourceVersionId} · {e.locator}
                          <br />
                          {e.excerpt}
                          <br />
                          来源 SHA256 {e.sourceSha256}
                        </article>
                      ))}
                      <p className="team-caption">
                        计算 {version.data.snapshot.calculationVersion} ·{' '}
                        {version.data.snapshot.roundingPolicy} · 币种精度{' '}
                        {version.data.snapshot.currencyScale}
                      </p>
                    </details>
                  </>
                )
              )}
            </>
          )}
        </>
      )}
      <ApprovalPanel
        member={member}
        threadId={threadId}
        quoteVersionId={versionId ?? null}
        contextRevision={contextRevision}
      />
    </section>
  );
}
function QuotePreview({ snapshot: s }: { snapshot: QuoteSnapshot }) {
  return (
    <article className="quote-preview" lang="en" aria-label="英文报价预览">
      <h4>QUOTATION</h4>
      <div className="quote-preview-subtitle">
        SIMULATION · INTERNAL PREVIEW · NOT APPROVED FOR SENDING
      </div>
      <dl className="commerce-definition">
        <dt>Quote</dt>
        <dd>
          {s.quoteNumber} · Version {s.version}
        </dd>
        <dt>Issued</dt>
        <dd>{commerceDate(s.createdAt)}</dd>
        <dt>Seller</dt>
        <dd>
          {s.seller.name} (simulated factory)
          <br />
          Sales agent: {s.seller.agent}
        </dd>
        <dt>Recipient</dt>
        <dd>
          {s.buyer.contactName} · {s.buyer.name}
          <br />
          {s.buyer.channelIdentity}
        </dd>
        <dt>Product</dt>
        <dd>
          {s.requirements.specifications.fabric}; {s.requirements.specifications.dimensions};{' '}
          {s.requirements.specifications.color}; {s.requirements.specifications.printing}
        </dd>
        <dt>Quantity</dt>
        <dd>
          {s.requirements.quantity} {s.requirements.unitCode}
        </dd>
        <dt>Valid until</dt>
        <dd>
          {commerceDate(s.validUntil)} ({s.timeZone})
        </dd>
      </dl>
      <h5>Product-only pricing · {s.currency}</h5>
      <div className="commerce-table-scroll">
        <table className="commerce-table">
          <thead>
            <tr>
              <th>Description</th>
              <th>Qty</th>
              <th className="money">Unit price</th>
              <th className="money">Amount</th>
            </tr>
          </thead>
          <tbody>
            {s.lines.map((line, i) => (
              <tr key={i}>
                <td>{line.description}</td>
                <td>
                  {line.quantity}
                  <br />
                  {line.unitCode}
                </td>
                <td className="money">{commerceDecimal(line.unitPrice, 2)}</td>
                <td className="money">
                  {line.kind === 'discount' ? '− ' : ''}
                  {line.amount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="quote-total">
        Total {s.currency} {s.totalAmount}
      </div>
      <h5>Production</h5>
      <p className="preview-terms">
        {s.production.days}{' '}
        {s.production.dayKind === 'business' ? 'business days' : 'calendar days'}, starting after{' '}
        {s.production.startConditions}.<br />
        No committed arrival date. Buyer timing request:{' '}
        {s.requirements.requestedTiming || 'Not specified'}.
      </p>
      <h5>Scope and exclusions</h5>
      <p className="preview-terms">
        Product-only quotation. Freight and taxes are not included. This is not a landed total.
      </p>
      <ul>
        {s.exclusions.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
      <h5>Samples and payment</h5>
      <p className="preview-terms">
        {s.sampleTerms}
        <br />
        Payment: {s.paymentTerms ?? 'To be confirmed; no payment ratio or bank details committed.'}
      </p>
      {s.pendingItems.length > 0 && (
        <>
          <h5>To be confirmed</h5>
          <ul>
            {s.pendingItems.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </>
      )}
      <p className="quote-preview-subtitle">
        The factory remains the contracting, payment-receiving and fulfilment party. No message has
        been sent.
      </p>
    </article>
  );
}
