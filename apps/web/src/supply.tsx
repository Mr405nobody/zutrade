import { useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Box, FileText, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '@zutrade/ui';
import type { FactoryView, MemberView } from '@zutrade/contracts';
import { commerceDate, commerceDecimal, commerceRequest } from './commerce-api';

interface Product {
  id: string;
  factory_id: string;
  factory_name?: string;
  name: string;
  sku: string;
  unit_code: string;
  state: string;
}
interface Source {
  id: string;
  title: string;
  document_id: string;
  document_row_version: string;
  version_no: number;
  source_kind: string;
  content_type: string;
  content_size: number;
  content_sha256: string;
  object_key: string | null;
  valid_until: string;
  revoked_at: string | null;
  document_state: string;
  is_current?: boolean;
}
interface SupplyValue {
  seller: { name: string };
  specifications: { fabric: string; dimensions: string; color: string; printing: string };
  production: { days: number; dayKind: 'business' | 'calendar'; startConditions: string };
  discountBoundary: { basis: 'product_subtotal'; maxPercent: string };
  sampleTerms: string;
  exclusions: string[];
  simulation: true;
}
interface Fact {
  id: string;
  fact_key: string;
  version_no: number;
  state: string;
  disclosure: string;
  valid_until: string;
  verified_by_member_id: string | null;
  verified_at: string | null;
  invalidation_reason: string | null;
  usable?: boolean;
  current_status?: string;
  value: SupplyValue;
  evidence: { source_version_id: string; locator: string; excerpt: string }[];
}
interface Price {
  id: string;
  qty_min: string;
  qty_max: string | null;
  unit_code: string;
  currency_code: string;
  unit_price: string;
  setup_fee: string;
  valid_until: string;
  fact_state: string;
  invalidated_at: string | null;
  is_current: boolean;
  usable?: boolean;
}
interface ProductDetail {
  product: Product;
  sources: Source[];
  facts: Fact[];
  prices: Price[];
}
function validDate(value: FormDataEntryValue | null) {
  return new Date(String(value)).toISOString();
}
function isFuture(value: string) {
  return new Date(value).getTime() > Date.now();
}
function valueFromForm(form: FormData): SupplyValue {
  return {
    seller: { name: String(form.get('seller')) },
    specifications: {
      fabric: String(form.get('fabric')),
      dimensions: String(form.get('dimensions')),
      color: String(form.get('color')),
      printing: String(form.get('printing')),
    },
    production: {
      days: Number(form.get('days')),
      dayKind: form.get('dayKind') === 'calendar' ? 'calendar' : 'business',
      startConditions: String(form.get('startConditions')),
    },
    discountBoundary: { basis: 'product_subtotal', maxPercent: String(form.get('maxPercent')) },
    sampleTerms: String(form.get('sampleTerms')),
    exclusions: String(form.get('exclusions'))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    simulation: true,
  };
}
function SourceSelect({ sources }: { sources: Source[] }) {
  return (
    <label>
      来源版本
      <select aria-label="来源版本" name="sourceVersionId" required defaultValue="">
        <option value="" disabled>
          选择有效来源
        </option>
        {sources
          .filter(
            (s) =>
              !s.revoked_at &&
              s.document_state === 'active' &&
              s.is_current !== false &&
              isFuture(s.valid_until),
          )
          .map((s) => (
            <option key={s.id} value={s.id}>
              {s.title} · v{s.version_no}
            </option>
          ))}
      </select>
    </label>
  );
}
function ValueFields({
  value,
  factoryName,
}: {
  value?: SupplyValue | undefined;
  factoryName?: string | undefined;
}) {
  return (
    <>
      <label>
        卖方名称（模拟工厂）
        <input
          name="seller"
          defaultValue={value?.seller.name ?? factoryName ?? ''}
          required
          maxLength={1000}
        />
      </label>
      <label>
        面料
        <input
          name="fabric"
          defaultValue={value?.specifications.fabric ?? ''}
          placeholder="例如 12oz"
          required
        />
      </label>
      <label>
        尺寸
        <input
          name="dimensions"
          defaultValue={value?.specifications.dimensions ?? ''}
          placeholder="例如 35×40cm"
          required
        />
      </label>
      <label>
        颜色
        <input
          name="color"
          defaultValue={value?.specifications.color ?? ''}
          placeholder="例如 Natural"
          required
        />
      </label>
      <label>
        印刷配置
        <input
          name="printing"
          defaultValue={value?.specifications.printing ?? ''}
          placeholder="Single colour / single side logo"
          required
        />
      </label>
      <label>
        生产周期
        <input
          name="days"
          type="number"
          min="0"
          max="3650"
          step="1"
          defaultValue={value?.production.days ?? ''}
          required
        />
      </label>
      <label>
        生产日类型
        <select name="dayKind" defaultValue={value?.production.dayKind ?? 'business'}>
          <option value="business">工作日</option>
          <option value="calendar">自然日</option>
        </select>
      </label>
      <label>
        生产起算条件
        <input
          name="startConditions"
          defaultValue={value?.production.startConditions ?? ''}
          placeholder="图稿/样品及订金确认后"
          required
          maxLength={1000}
        />
      </label>
      <label>
        样品条款
        <input
          name="sampleTerms"
          defaultValue={value?.sampleTerms ?? ''}
          placeholder="Samples quoted separately"
          required
        />
      </label>
      <label>
        最大折扣比例（产品小计 %）
        <input
          name="maxPercent"
          type="number"
          min="0"
          max="100"
          step="0.000001"
          defaultValue={value?.discountBoundary.maxPercent ?? '0'}
          required
        />
      </label>
      <label className="wide">
        排除项（每行一项）
        <textarea
          name="exclusions"
          defaultValue={value?.exclusions.join('\n') ?? ''}
          placeholder={'Freight excluded\nTaxes excluded\nSamples quoted separately'}
          required
        />
      </label>
    </>
  );
}
export function ProductsPanel({ member }: { member: MemberView }) {
  const base = `/api/workspaces/${member.workspace_id}/supply`;
  const cache = useQueryClient();
  const [factoryId, setFactoryId] = useState('');
  const [selected, setSelected] = useState('');
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sourceRevision, setSourceRevision] = useState<{
    documentId: string;
    expectedVersion: string;
  } | null>(null);
  const key = ['supply', member.id];
  const products = useQuery({
    queryKey: key,
    queryFn: () => commerceRequest<{ items: Product[] }>(`${base}/products`),
    retry: false,
    refetchInterval: 10000,
  });
  const factories = useQuery({
    queryKey: ['factories', member.id],
    queryFn: () =>
      commerceRequest<FactoryView[]>(`/api/workspaces/${member.workspace_id}/factories`),
    retry: false,
  });
  const product = useQuery({
    queryKey: [...key, selected],
    queryFn: () => commerceRequest<ProductDetail>(`${base}/products/${selected}`),
    enabled: Boolean(selected),
    retry: false,
    refetchInterval: 10000,
  });
  async function mutate(
    name: string,
    path: string,
    body: unknown,
    after?: (result: { id?: string }) => void,
  ) {
    setPending(name);
    setError('');
    setNotice('');
    try {
      const result = await commerceRequest<{ id?: string }>(path, body);
      after?.(result);
      await cache.invalidateQueries({ queryKey: key });
      setNotice('已保存到服务器。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
      await cache.invalidateQueries({ queryKey: key });
    } finally {
      setPending('');
    }
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get('file');
    if (!(file instanceof File) || !file.size) {
      setError('请选择来源文件。');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('文件超过 5 MiB，请缩小后上传。');
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      await mutate(
        'upload',
        `${base}/products/${selected}/sources`,
        {
          title: form.get('title'),
          contentBase64: btoa(binary),
          validUntil: validDate(form.get('validUntil')),
          ...(sourceRevision
            ? {
                sourceDocumentId: sourceRevision.documentId,
                expectedVersion: sourceRevision.expectedVersion,
              }
            : {}),
        },
        () => setSourceRevision(null),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '文件读取失败');
    }
  }
  const data = product.data;
  const latestValue = data?.facts.find((f) => f.state === 'published')?.value;
  return (
    <main className="commerce-page" aria-label="可信供给">
      <div className="commerce-heading">
        <div>
          <h1>产品与可信供给</h1>
          <p>来源、事实与价阶 · 所有演示工厂及供给均为模拟</p>
        </div>
        <Button
          variant="outline"
          onClick={() => void cache.invalidateQueries({ queryKey: key })}
          disabled={products.isFetching}
        >
          <RefreshCw size={14} /> 刷新
        </Button>
      </div>
      <div className="commerce-factories">
        <label>
          授权工厂
          <select
            aria-label="筛选产品工厂"
            value={factoryId}
            onChange={(e) => {
              setFactoryId(e.target.value);
              setSelected('');
            }}
          >
            <option value="">全部授权工厂</option>
            {factories.data?.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {factories.isError && (
        <p className="commerce-error" role="alert">
          {factories.error.message}
        </p>
      )}
      <div className="commerce-toolbar">
        <Button variant="outline" onClick={() => setAdding(!adding)}>
          {adding ? '收起新产品' : '录入新产品'}
        </Button>
        <span className="commerce-status muted">sales 可录入 · owner 确认发布</span>
      </div>
      {adding && (
        <section className="commerce-card">
          <h3>录入模拟产品</h3>
          <form
            className="commerce-form"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              void mutate(
                'product',
                `${base}/products`,
                {
                  factoryId: form.get('factoryId'),
                  sku: form.get('sku'),
                  name: form.get('name'),
                  unitCode: 'piece',
                  configuration: {},
                },
                (result) => {
                  if (result.id) setSelected(result.id);
                  setAdding(false);
                },
              );
            }}
          >
            <label>
              工厂
              <select name="factoryId" required defaultValue={factoryId}>
                <option value="" disabled>
                  选择工厂
                </option>
                {factories.data?.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              产品编号
              <input name="sku" required maxLength={64} />
            </label>
            <label className="wide">
              产品名称
              <input name="name" required maxLength={1000} />
            </label>
            <p className="form-help wide">
              本阶段单位为 piece；创建产品不会自动确认任何价格或供货条件。
            </p>
            <Button disabled={Boolean(pending)}>
              {pending === 'product' ? '正在保存…' : '保存产品'}
            </Button>
          </form>
        </section>
      )}
      {error && (
        <p className="commerce-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="commerce-status" role="status">
          {notice}
        </p>
      )}
      {products.isPending ? (
        <p className="commerce-empty">正在读取产品…</p>
      ) : products.isError ? (
        <div className="commerce-error" role="alert">
          {products.error.message}
          <button className="text-button" onClick={() => void products.refetch()}>
            重试
          </button>
        </div>
      ) : !products.data?.items.length ? (
        <div className="commerce-empty">
          <Box size={30} />
          <p>尚无产品。先在授权工厂下录入产品，再上传来源及整理事实。</p>
        </div>
      ) : (
        products.data.items
          .filter((p) => !factoryId || p.factory_id === factoryId)
          .map((p) => (
            <article className="commerce-card" key={p.id}>
              <div className="commerce-card-heading">
                <div>
                  <strong>
                    {p.sku} · {p.name}
                  </strong>
                  <p>
                    {p.factory_name} · {p.unit_code}
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => (
                    setSelected(selected === p.id ? '' : p.id),
                    setSourceRevision(null)
                  )}
                  aria-expanded={selected === p.id}
                >
                  {selected === p.id ? '收起资料' : '查看来源与价阶'}
                </Button>
              </div>
              <div className="commerce-badges">
                <span className="simulation-tag">模拟供给</span>
                <span className="commerce-status muted">供给确认独立于报价审批</span>
              </div>
              {selected === p.id && (
                <div className="commerce-detail">
                  {product.isPending ? (
                    <p>正在读取资料…</p>
                  ) : product.isError ? (
                    <p className="commerce-error" role="alert">
                      {product.error.message}
                    </p>
                  ) : (
                    data && (
                      <>
                        <section>
                          <h3>当前与历史价阶</h3>
                          {!data.prices.length ? (
                            <p className="commerce-empty">尚无已发布价阶，不能生成有效报价。</p>
                          ) : (
                            <div className="commerce-table-scroll">
                              <table className="commerce-table">
                                <thead>
                                  <tr>
                                    <th>适用数量</th>
                                    <th>单价 / 设置费</th>
                                    <th>状态</th>
                                    <th>有效期</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {data.prices.map((r) => (
                                    <tr key={r.id}>
                                      <td>
                                        {commerceDecimal(r.qty_min)} ≤ 数量{' '}
                                        {r.qty_max ? `< ${commerceDecimal(r.qty_max)}` : ''}
                                        <br />
                                        {r.unit_code}
                                      </td>
                                      <td>
                                        {r.currency_code} {commerceDecimal(r.unit_price, 2)}
                                        <br />
                                        每份报价 {commerceDecimal(r.setup_fee, 2)}
                                      </td>
                                      <td>
                                        {r.usable !== false &&
                                        r.fact_state === 'published' &&
                                        r.is_current &&
                                        !r.invalidated_at &&
                                        isFuture(r.valid_until)
                                          ? '资料已确认'
                                          : '历史 / 需重核'}
                                      </td>
                                      <td>{commerceDate(r.valid_until)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </section>
                        <section className="commerce-section">
                          <h3>来源版本</h3>
                          {data.sources.length ? (
                            data.sources.map((s) => (
                              <article className="commerce-source" key={s.id}>
                                <div className="commerce-inline">
                                  <FileText size={14} />
                                  <strong>
                                    {s.title} · v{s.version_no}
                                  </strong>
                                  <span
                                    className={`commerce-status ${s.revoked_at || !isFuture(s.valid_until) ? 'warning' : 'muted'}`}
                                  >
                                    {s.revoked_at
                                      ? '已撤回'
                                      : !isFuture(s.valid_until)
                                        ? '已过期'
                                        : '来源已保存 · 事实另行确认'}
                                  </span>
                                </div>
                                <p>
                                  {s.is_current === false ? '历史来源版本 · ' : ''}
                                  {s.content_type} · {s.content_size} 字节 · 有效至{' '}
                                  {commerceDate(s.valid_until)}
                                </p>
                                <small>SHA256 {s.content_sha256}</small>
                                <div className="commerce-toolbar">
                                  {s.object_key && (
                                    <a
                                      href={`${base}/sources/${s.id}/file`}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      下载私有来源
                                    </a>
                                  )}
                                  {member.role === 'owner' && !s.revoked_at && (
                                    <WithdrawForm
                                      label="撤回此来源"
                                      pending={Boolean(pending)}
                                      save={(reason) =>
                                        mutate('withdraw', `${base}/sources/${s.id}/withdraw`, {
                                          reason,
                                        })
                                      }
                                    />
                                  )}
                                </div>
                              </article>
                            ))
                          ) : (
                            <p className="commerce-empty">暂无来源。</p>
                          )}
                          <details className="commerce-detail">
                            <summary>上传新来源文件</summary>
                            <form className="commerce-form" onSubmit={(e) => void upload(e)}>
                              <label className="wide">
                                来源版本归属
                                <select
                                  name="sourceDocumentId"
                                  aria-label="来源版本归属"
                                  value={sourceRevision?.documentId ?? ''}
                                  onChange={(e) => {
                                    const source = data.sources.find(
                                      (s) =>
                                        s.document_id === e.target.value && s.is_current !== false,
                                    );
                                    setSourceRevision(
                                      source
                                        ? {
                                            documentId: source.document_id,
                                            expectedVersion: source.document_row_version,
                                          }
                                        : null,
                                    );
                                  }}
                                >
                                  <option value="">建立新来源</option>
                                  {data.sources
                                    .filter(
                                      (s) =>
                                        s.source_kind === 'file' &&
                                        s.is_current !== false &&
                                        !s.revoked_at,
                                    )
                                    .map((s) => (
                                      <option key={s.id} value={s.document_id}>
                                        {s.title} · 追加 v{s.version_no + 1}
                                      </option>
                                    ))}
                                </select>
                              </label>
                              <label>
                                来源标题
                                <input name="title" required maxLength={1000} />
                              </label>
                              <label>
                                有效截止时间（本地时区）
                                <input type="datetime-local" name="validUntil" required />
                              </label>
                              <label className="wide">
                                文件
                                <input
                                  name="file"
                                  type="file"
                                  accept=".txt,.pdf,.png,.jpg,.jpeg"
                                  required
                                />
                              </label>
                              <p className="wide form-help">
                                TXT、PDF、PNG 或 JPEG，最多 5
                                MiB。上传不等于确认，原始附件不会自动进入报价 PDF。
                              </p>
                              <Button disabled={Boolean(pending)}>
                                {pending === 'upload' ? '正在上传…' : '保存来源版本'}
                              </Button>
                            </form>
                          </details>
                        </section>
                        <section className="commerce-section">
                          <h3>结构化事实与确认</h3>
                          {data.facts.map((f) => (
                            <article className="commerce-fact" key={f.id}>
                              <div className="commerce-inline">
                                <strong>
                                  {f.fact_key} · v{f.version_no}
                                </strong>
                                <span
                                  className={`commerce-status ${f.state === 'published' && f.usable !== false ? '' : 'warning'}`}
                                >
                                  {f.state === 'draft'
                                    ? '资料待确认'
                                    : f.state === 'published'
                                      ? f.usable === false
                                        ? '资料需要重核'
                                        : '资料已确认'
                                      : '已失效 / 历史'}
                                </span>
                              </div>
                              <p>
                                {f.value.specifications.fabric} ·{' '}
                                {f.value.specifications.dimensions} · {f.value.specifications.color}{' '}
                                · {f.value.specifications.printing}
                              </p>
                              <p>
                                生产 {f.value.production.days}{' '}
                                {f.value.production.dayKind === 'business' ? '工作日' : '自然日'}；
                                {f.value.production.startConditions}
                              </p>
                              <small>
                                有效至 {commerceDate(f.valid_until)} ·{' '}
                                {f.disclosure === 'buyer_visible' ? '允许买家披露' : '仅内部'} ·
                                确认成员 {f.verified_by_member_id?.slice(0, 8) ?? '待确认'} ·{' '}
                                {commerceDate(f.verified_at)}
                              </small>
                              {f.invalidation_reason && (
                                <p className="commerce-error">{f.invalidation_reason}</p>
                              )}
                              {f.evidence.map((v, i) => (
                                <div className="quote-evidence" key={i}>
                                  来源版本 {v.source_version_id.slice(0, 8)} · {v.locator}
                                  <br />
                                  {v.excerpt}
                                </div>
                              ))}
                              {member.role === 'owner' && (
                                <div className="commerce-toolbar">
                                  {f.state === 'draft' && (
                                    <Button
                                      disabled={Boolean(pending)}
                                      onClick={() =>
                                        void mutate('publish', `${base}/facts/${f.id}/publish`, {})
                                      }
                                    >
                                      <ShieldCheck size={14} /> 确认并发布事实
                                    </Button>
                                  )}
                                  {f.state === 'published' && (
                                    <WithdrawForm
                                      label="撤回此事实"
                                      pending={Boolean(pending)}
                                      save={(reason) =>
                                        mutate('withdraw', `${base}/facts/${f.id}/withdraw`, {
                                          reason,
                                        })
                                      }
                                    />
                                  )}
                                </div>
                              )}
                            </article>
                          ))}
                          <details className="commerce-detail">
                            <summary>录入待确认事实</summary>
                            <form
                              className="commerce-form"
                              onSubmit={(e) => {
                                e.preventDefault();
                                const f = new FormData(e.currentTarget);
                                void mutate('fact', `${base}/products/${selected}/facts`, {
                                  sourceVersionId: f.get('sourceVersionId'),
                                  locator: f.get('locator'),
                                  excerpt: f.get('excerpt'),
                                  factKey: 'supply_terms',
                                  scopeKey: 'default',
                                  value: valueFromForm(f),
                                  applicability: {},
                                  validUntil: validDate(f.get('validUntil')),
                                  disclosure: f.get('disclosure'),
                                });
                              }}
                            >
                              <SourceSelect sources={data.sources} />
                              <label>
                                有效截止时间
                                <input type="datetime-local" name="validUntil" required />
                              </label>
                              <label>
                                来源定位
                                <input
                                  name="locator"
                                  placeholder="例如 第 1 页 / 价格条款"
                                  required
                                  maxLength={1000}
                                />
                              </label>
                              <label>
                                披露范围
                                <select name="disclosure" defaultValue="buyer_visible">
                                  <option value="buyer_visible">买家可见</option>
                                  <option value="internal">仅内部</option>
                                </select>
                              </label>
                              <label className="wide">
                                证据原文片段
                                <textarea name="excerpt" required maxLength={1000} />
                              </label>
                              <ValueFields value={latestValue} factoryName={p.factory_name} />
                              <p className="wide form-help">
                                保存为待确认事实，须由 owner 单独确认。全部内容为模拟资料。
                              </p>
                              <Button disabled={Boolean(pending)}>
                                {pending === 'fact' ? '正在保存…' : '保存待确认事实'}
                              </Button>
                            </form>
                          </details>
                        </section>
                        {member.role === 'owner' ? (
                          <details className="commerce-detail">
                            <summary>发布新价阶或价格版本 · owner</summary>
                            <form
                              className="commerce-form"
                              onSubmit={(e) => {
                                e.preventDefault();
                                const f = new FormData(e.currentTarget);
                                void mutate('price', `${base}/products/${selected}/prices`, {
                                  sourceVersionId: f.get('sourceVersionId'),
                                  locator: f.get('locator'),
                                  excerpt: f.get('excerpt'),
                                  scopeKey: 'default',
                                  value: valueFromForm(f),
                                  applicability: {},
                                  validUntil: validDate(f.get('validUntil')),
                                  qtyMin: f.get('qtyMin'),
                                  qtyMax: f.get('qtyMax') || null,
                                  unitCode: 'piece',
                                  currencyCode: 'USD',
                                  unitPrice: f.get('unitPrice'),
                                  setupFee: f.get('setupFee'),
                                });
                              }}
                            >
                              <SourceSelect sources={data.sources} />
                              <label>
                                有效截止时间
                                <input type="datetime-local" name="validUntil" required />
                              </label>
                              <label>
                                数量下界（包含）
                                <input name="qtyMin" type="number" min="1" step="1" required />
                              </label>
                              <label>
                                数量上界（不包含）
                                <input
                                  name="qtyMax"
                                  type="number"
                                  min="2"
                                  step="1"
                                  placeholder="500—999 件请填 1000"
                                />
                              </label>
                              <label>
                                USD 单价 / piece
                                <input
                                  name="unitPrice"
                                  type="number"
                                  min="0"
                                  step="0.000001"
                                  required
                                />
                              </label>
                              <label>
                                USD 设置费 / 每份报价
                                <input
                                  name="setupFee"
                                  type="number"
                                  min="0"
                                  step="0.000001"
                                  required
                                />
                              </label>
                              <label className="wide">
                                来源定位
                                <input name="locator" required maxLength={1000} />
                              </label>
                              <label className="wide">
                                证据片段
                                <textarea name="excerpt" required maxLength={1000} />
                              </label>
                              <ValueFields value={latestValue} factoryName={p.factory_name} />
                              <p className="wide form-help">
                                发布会建立新冻结规则与事实版本，旧版本保留。相同条件下重叠价阶会被服务器拒绝。供给发布不等于报价外发批准。
                              </p>
                              <Button disabled={Boolean(pending)}>
                                {pending === 'price' ? '正在发布…' : '确认并发布新价阶'}
                              </Button>
                            </form>
                          </details>
                        ) : (
                          <p className="commerce-notice">
                            你可以上传来源、整理待确认事实；关键价格与生产条件由 owner 确认发布。
                          </p>
                        )}
                      </>
                    )
                  )}
                </div>
              )}
            </article>
          ))
      )}
    </main>
  );
}
function WithdrawForm({
  label,
  pending,
  save,
}: {
  label: string;
  pending: boolean;
  save: (reason: string) => Promise<void>;
}) {
  return (
    <details>
      <summary className="text-button">{label}</summary>
      <form
        className="commerce-form"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void save(String(f.get('reason')));
        }}
      >
        <label className="wide">
          撤回原因
          <input name="reason" required maxLength={1000} />
        </label>
        <Button variant="outline" disabled={pending}>
          确认撤回
        </Button>
      </form>
    </details>
  );
}
export function SupplyTasks({
  member,
  openProducts,
}: {
  member: MemberView;
  openProducts: () => void;
}) {
  const base = `/api/workspaces/${member.workspace_id}/supply`;
  const products = useQuery({
    queryKey: ['supply', member.id],
    queryFn: () => commerceRequest<{ items: Product[] }>(`${base}/products`),
    retry: false,
  });
  const tasks = useQuery({
    queryKey: ['supply-tasks', member.id, products.data?.items.map((p) => p.id).join(',')],
    queryFn: async () => {
      const details = await Promise.all(
        (products.data?.items ?? []).map((p) =>
          commerceRequest<ProductDetail>(`${base}/products/${p.id}`),
        ),
      );
      return details.flatMap((d) => [
        ...d.facts
          .filter((f) => f.state === 'draft')
          .map((f) => ({
            id: f.id,
            title: `${d.product.sku} · 资料待确认`,
            detail: `${f.fact_key} v${f.version_no}，${member.role === 'owner' ? '请核对证据后发布' : '请交由 owner 核对发布'}`,
          })),
        ...d.sources
          .filter((s) => s.revoked_at || !isFuture(s.valid_until))
          .map((s) => ({
            id: s.id,
            title: `${d.product.sku} · 来源需要重核`,
            detail: `${s.title}：${s.revoked_at ? '已撤回' : '已到期'}，相关报价需检查当前依据。`,
          })),
      ]);
    },
    enabled: Boolean(products.data),
    retry: false,
    refetchInterval: 10000,
  });
  return (
    <main className="commerce-page" aria-label="供给待办">
      <div className="commerce-heading">
        <div>
          <h1>待办</h1>
          <p>供给资料需要团队处理的事项</p>
        </div>
        <Button variant="outline" onClick={openProducts}>
          前往产品
        </Button>
      </div>
      <div className="commerce-notice">
        报价与自由文本审批请在上方处理；自动跟进在 D2 开放。供给确认不等于外发审批。
      </div>
      {products.isError || tasks.isError ? (
        <p className="commerce-error" role="alert">
          {products.error?.message ?? tasks.error?.message}
        </p>
      ) : tasks.isPending ? (
        <p className="commerce-empty">正在检查待确认事项…</p>
      ) : tasks.data?.length ? (
        <section className="commerce-card">
          {tasks.data.map((t) => (
            <article className="commerce-task" key={t.id}>
              <strong>{t.title}</strong>
              <p>{t.detail}</p>
              <button className="text-button" onClick={openProducts}>
                查看来源与事实
              </button>
            </article>
          ))}
        </section>
      ) : (
        <p className="commerce-empty">
          当前没有待确认或失效的供给资料。会话中的采购需求与报价依据可在内部工作区核对。
        </p>
      )}
    </main>
  );
}
