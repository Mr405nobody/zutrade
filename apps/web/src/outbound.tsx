import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, Search } from 'lucide-react';
import { Button } from '@zutrade/ui';
import { outboundQueries } from '@zutrade/contracts';
import type {
  MemberView,
  FactoryView,
  OutboundDashboard,
  OutboundCompanyDetail,
  OutboundInput,
  OutboundReviewInput,
} from '@zutrade/contracts';
import { commerceRequest, commerceDate } from './commerce-api';
const status: Record<string, string> = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已驳回',
  needs_info: '待补充调查',
  queued: '等待执行',
  running: '正在读取公开网页',
  completed: '任务完成',
  partial: '部分完成',
  failed: '任务失败',
  cancelled: '已取消',
};
const errors: Record<string, string> = {
  AUTOMATIC_SEARCH_UNAVAILABLE: '自动搜索不可用，请使用手动官网导入。',
  SSRF_DNS_REJECTED: 'DNS 返回私网或保留地址，已安全拒绝。当前网络无法读取该官网。',
  RUN_DEADLINE: '达到 180 秒任务期限，已保留取得的资料。',
  REQUEST_TIMEOUT: '官网读取超时。',
  ROBOTS_DISALLOWED: 'robots.txt 禁止访问，已停止读取该页面。',
  CROSS_ORIGIN_REDIRECT_REJECTED: '官网跳转到其他来源，请核对最终官网后重新导入。',
  PRODUCT_NOT_CONFIRMED: '未取得目标产品的官网依据，未纳入候选。',
  EXCLUDED_EXPLICIT_COUNTRY_MISMATCH: '官网自述国家与目标不符，已排除。',
  REQUEST_BUDGET_EXHAUSTED: '达到累计请求上限，已保留部分结果。',
};
function source(url: string, label: string) {
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
      return <span>来源链接不可用</span>;
  } catch {
    return <span>来源链接不可用</span>;
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {label} <ExternalLink size={12} />
    </a>
  );
}
export function OutboundPanel({ member }: { member: MemberView }) {
  const companyId = window.location.pathname.match(/^\/outbound\/companies\/([\da-f-]+)$/i)?.[1];
  return companyId ? (
    <CompanyDetail key={`${member.id}:${companyId}`} member={member} id={companyId} />
  ) : (
    <OutboundList member={member} />
  );
}
function OutboundList({ member }: { member: MemberView }) {
  const base = `/api/workspaces/${member.workspace_id}/outbound`;
  const cache = useQueryClient();
  const [factory, setFactory] = useState(''),
    [product, setProduct] = useState('Industrial Fasteners'),
    [country, setCountry] = useState('US');
  const [buyerType, setBuyerType] = useState<OutboundInput['buyerType']>('Distributor'),
    [limit, setLimit] = useState(20),
    [mode, setMode] = useState<OutboundInput['mode']>('manual');
  const [urls, setUrls] = useState(''),
    [permission, setPermission] = useState(false),
    [approvedOnly, setApprovedOnly] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [selected, setSelected] = useState('');
  const factories = useQuery({
    queryKey: ['factories', member.id],
    queryFn: () =>
      commerceRequest<FactoryView[]>(`/api/workspaces/${member.workspace_id}/factories`),
    retry: false,
  });
  const dashboard = useQuery({
    queryKey: ['outbound', member.id],
    queryFn: () => commerceRequest<OutboundDashboard>(base),
    refetchInterval: 2000,
    retry: false,
  });
  useEffect(() => {
    if (!factory && factories.data?.[0]) setFactory(factories.data[0].id);
  }, [factories.data, factory]);
  const runs = dashboard.data?.runs ?? [];
  const run = runs.find((r) => r.id === selected) ?? runs[0];
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await commerceRequest<{ runId: string }>(`${base}/runs`, {
        commandId: crypto.randomUUID(),
        factoryId: factory,
        product,
        country,
        buyerType,
        limit,
        mode,
        websiteUrls: mode === 'manual' ? urls.split(/\s+/).filter(Boolean) : [],
        permissionAcknowledged: permission,
      });
      setSelected(result.runId);
      await cache.invalidateQueries({ queryKey: ['outbound', member.id] });
    } catch (e) {
      setError(e instanceof Error ? e.message : '任务未创建');
    } finally {
      setBusy(false);
    }
  }
  const companies = (dashboard.data?.companies ?? []).filter(
    (c) => !approvedOnly || c.review_status === 'approved',
  );
  return (
    <main className="outbound-page">
      <div className="section-heading">
        <div>
          <div className="eyebrow">ZUTRADE OUTBOUND INTELLIGENCE</div>
          <h1>主动获客与企业背调</h1>
          <p>公开官网资料 → 规则初筛 → 人工审核</p>
        </div>
        <a href="/prospecting">原研究与模拟批次</a>
      </div>
      <p className="research-notice" role="status">
        {dashboard.data?.automatic.detail ?? '正在检查搜索配置…'}{' '}
        资料采集需要真实公网可达；规则生成，无真实模型。
      </p>
      {dashboard.isError && (
        <p className="research-error" role="alert">
          {dashboard.error.message}
          <Button variant="outline" onClick={() => void dashboard.refetch()}>
            重新读取
          </Button>
        </p>
      )}
      <div className="outbound-grid">
        <section className="outbound-card">
          <h2>
            <Search size={19} /> 新建寻客任务
          </h2>
          <form onSubmit={(e) => void submit(e)} className="research-form">
            <label>
              代表工厂
              <select
                aria-label="代表工厂"
                value={factory}
                onChange={(e) => setFactory(e.target.value)}
                required
              >
                <option value="">选择有权工厂</option>
                {factories.data
                  ?.filter((f) => f.status === 'active')
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </select>
            </label>
            {factories.isError && <p role="alert">{factories.error.message}</p>}
            <label>
              产品关键词
              <input
                aria-label="产品关键词"
                value={product}
                onChange={(e) => setProduct(e.target.value)}
                minLength={2}
                maxLength={60}
                required
              />
            </label>
            <label>
              目标国家
              <select
                aria-label="目标国家"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
              >
                {Object.entries({
                  US: 'United States',
                  GB: 'United Kingdom',
                  AU: 'Australia',
                  SG: 'Singapore',
                  CA: 'Canada',
                  DE: 'Germany',
                }).map(([v, n]) => (
                  <option key={v} value={v}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label>
              买家类型
              <select
                aria-label="买家类型"
                value={buyerType}
                onChange={(e) => setBuyerType(e.target.value as OutboundInput['buyerType'])}
              >
                {['Importer', 'Distributor', 'Wholesaler'].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              目标企业数量
              <input
                aria-label="目标企业数量"
                type="number"
                min={1}
                max={20}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                required
              />
            </label>
            <label>
              发现模式
              <select
                aria-label="发现模式"
                value={mode}
                onChange={(e) => setMode(e.target.value as OutboundInput['mode'])}
              >
                <option value="manual">手动官网导入</option>
                <option value="automatic">自动搜索（当前不可用）</option>
              </select>
            </label>
            {mode === 'manual' && (
              <>
                <label>
                  企业官网 URL（每行一个，最多 20 家）
                  <textarea
                    aria-label="企业官网 URL"
                    value={urls}
                    onChange={(e) => setUrls(e.target.value)}
                    rows={4}
                    required
                    placeholder="https://企业官网域名/"
                  />
                </label>
                <label className="research-checkbox">
                  <input
                    type="checkbox"
                    checked={permission}
                    onChange={(e) => setPermission(e.target.checked)}
                    required
                  />
                  我已核对网站使用条件，具有采集和保存必要公开事实摘录的权限；系统仍检查
                  robots.txt。
                </label>
              </>
            )}
            <Button disabled={busy || !factory || dashboard.isError} type="submit">
              {busy ? '正在创建任务…' : mode === 'manual' ? '导入官网并调查' : '开始搜索'}
            </Button>
            {error && (
              <p role="alert" className="research-error">
                {error}
              </p>
            )}
          </form>
          <details>
            <summary>规则生成的英文查询（尚未执行搜索）</summary>
            {outboundQueries(product, country, buyerType).map((q) => (
              <p key={q}>{q}</p>
            ))}
          </details>
          <p className="research-help">
            最多 20 家、80 次请求、每站最多 4 页；全局并发 2、同站 1，至少间隔 1 秒；单请求 10
            秒，任务 180 秒。不执行脚本，不绕过访问限制。
          </p>
        </section>
        <section className="outbound-card">
          <h2>任务进度与结果</h2>
          <label>
            任务历史
            <select
              aria-label="任务历史"
              value={run?.id ?? ''}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">选择任务</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {commerceDate(r.created_at)} · {status[r.state]} · {r.candidate_count} 家
                </option>
              ))}
            </select>
          </label>
          {!run ? (
            <p>尚无任务。输入真实官网后开始调查。</p>
          ) : (
            <>
              <p>
                <strong>{status[run.state]}</strong> ·{' '}
                {run.provider === 'outbound_manual' ? '手动导入模式' : '自动搜索不可用'} ·{' '}
                {run.data_origin === 'offline_fixture' ? '离线测试数据' : '真实网络任务'}
              </p>
              <p>
                取得 {run.candidate_count} / 目标 {run.request.limit} 家 · 请求 {run.request_count}{' '}
                / 80
              </p>
              <progress aria-label="请求预算使用量" max={80} value={run.request_count} />
              <p>
                开始 {commerceDate(run.first_started_at)} · 截止 {commerceDate(run.deadline)}
              </p>
              {run.error && (
                <p className="research-error" role="alert">
                  {errors[run.error] ?? run.error}
                </p>
              )}
              {run.results_snapshot.truncationReason && (
                <p>{run.results_snapshot.truncationReason}</p>
              )}
              {run.finished_at && run.candidate_count === 0 && (
                <p>
                  未取得符合条件的企业，没有使用虚构公司补齐。请核对官网、产品条件和网络后新建任务。
                </p>
              )}
              {!run.finished_at && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setBusy(true);
                    void commerceRequest(
                      `/api/workspaces/${member.workspace_id}/prospecting/runs/${run.id}/cancel`,
                      {},
                    )
                      .then(() => cache.invalidateQueries({ queryKey: ['outbound', member.id] }))
                      .catch((e: Error) => setError(e.message))
                      .finally(() => setBusy(false));
                  }}
                  disabled={busy}
                >
                  停止任务
                </Button>
              )}
              <details>
                <summary>逐条来源反馈（抓取失败不代表企业风险）</summary>
                {run.results_snapshot.errors.map((e, i) => (
                  <p key={i}>
                    {source(e.url, e.url)}
                    <br />
                    {errors[e.code] ?? e.code}
                  </p>
                ))}
                <p>任务 {run.id}</p>
              </details>
            </>
          )}
        </section>
      </div>
      <section className="outbound-card">
        <div className="section-heading">
          <h2>企业名单 · {companies.length} 家</h2>
          <label className="research-checkbox">
            <input
              type="checkbox"
              checked={approvedOnly}
              onChange={(e) => setApprovedOnly(e.target.checked)}
            />
            仅查看已审核通过
          </label>
        </div>
        <p>
          按代表工厂和规范化域名去重。审核结果保留；重复导入不覆盖旧来源或人工结论。显示最近 100
          家、30 个任务。
        </p>
        {dashboard.isPending ? (
          <p>正在读取持久化资料…</p>
        ) : !companies.length ? (
          <p>暂无{approvedOnly ? '审核通过的' : '有产品依据的'}企业。</p>
        ) : (
          <div className="outbound-table">
            <table>
              <thead>
                <tr>
                  {['公司名称', '国家', '官网', '产品匹配', '背调状态', '人工审核', '详情'].map(
                    (s) => (
                      <th key={s}>{s}</th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {companies.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {c.corrections.name || c.name}
                      {c.data_origin === 'offline_fixture' && <small>离线测试数据</small>}
                    </td>
                    <td>{c.corrections.country || c.country || '未知'}</td>
                    <td>{source(`https://${c.domain}/`, c.domain)}</td>
                    <td>已取得官网词汇依据</td>
                    <td>规则初步背调</td>
                    <td>{status[c.review_status]}</td>
                    <td>
                      <a href={`/outbound/companies/${c.id}`}>查看企业</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
const emptyCorrections = {
  name: '',
  country: '',
  address: '',
  business: '',
  buyerType: '',
  sourceUrl: '',
};
function CompanyDetail({ member, id }: { member: MemberView; id: string }) {
  const base = `/api/workspaces/${member.workspace_id}/outbound/companies/${id}`;
  const query = useQuery({
    queryKey: ['outbound-company', member.id, id],
    queryFn: () => commerceRequest<OutboundCompanyDetail>(base),
    retry: false,
  });
  const [notes, setNotes] = useState(''),
    [corrections, setCorrections] = useState(emptyCorrections),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  useEffect(() => {
    if (query.data) {
      setCorrections({ ...emptyCorrections, ...query.data.company.corrections });
      setNotes(query.data.company.review_notes);
    }
  }, [query.data]);
  async function review(s: OutboundReviewInput['status']) {
    if (!query.data) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const r = await commerceRequest<OutboundCompanyDetail>(`${base}/review`, {
        revision: query.data.company.revision,
        status: s,
        notes,
        corrections,
      });
      queryClientUpdate(r);
      setMessage(`已保存：${status[s]}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '审核未保存');
      await query.refetch();
    } finally {
      setBusy(false);
    }
  }
  const cache = useQueryClient();
  function queryClientUpdate(r: OutboundCompanyDetail) {
    cache.setQueryData(['outbound-company', member.id, id], r);
    void cache.invalidateQueries({ queryKey: ['outbound', member.id] });
  }
  if (!query.data)
    return (
      <main className="outbound-page">
        <a href="/outbound">
          <ArrowLeft size={16} /> 返回主动获客
        </a>
        <p role={query.isError ? 'alert' : 'status'}>
          {query.isError ? query.error.message : '正在读取企业资料…'}
        </p>
      </main>
    );
  const { company, candidate, report, history } = query.data;
  return (
    <main className="outbound-page">
      <a href="/outbound">
        <ArrowLeft size={16} /> 返回主动获客
      </a>
      <div className="section-heading">
        <div>
          <div className="eyebrow">COMPANY DUE DILIGENCE</div>
          <h1>{company.corrections.name || company.name}</h1>
          <p>
            {company.domain} · {status[company.review_status]}
          </p>
        </div>
        <span>规则生成 · {report.version}</span>
      </div>
      {company.data_origin === 'offline_fixture' && (
        <p className="research-error">离线测试数据，不是真实发现的企业。</p>
      )}
      <p>
        调查时间：{commerceDate(report.investigatedAt)}
        。以下事实均为网页自述或文本命中；不能据此认定企业主体真实。
      </p>
      <div className="outbound-grid">
        <section className="outbound-card">
          <h2>1. 企业身份调查</h2>
          <dl>
            {report.facts.map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>
                  {f.value} {f.sourceUrl && source(f.sourceUrl, '原始来源')}
                </dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="outbound-card">
          <h2>2. 产品与业务匹配</h2>
          <p>{report.productMatch}</p>
          <p>{report.buyerMatch}</p>
          <p>{report.marketMatch}</p>
          <h2>3. 潜在采购价值（推断）</h2>
          {report.inferences.map((s) => (
            <p key={s}>{s}</p>
          ))}
          <h2>4. 已发现的风险线索</h2>
          {report.risks.length ? (
            report.risks.map((s) => <p key={s}>{s}</p>)
          ) : (
            <p>
              在已读取的有限资料中未识别明确不一致；不表示无风险。资料缺失及读取失败不作为欺诈判断。
            </p>
          )}
        </section>
      </div>
      <section className="outbound-card">
        <h2>5. 尚未核实的内容</h2>
        <ul>
          {report.unknowns.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </section>
      <section className="outbound-card">
        <h2>6. 证据链接与官网摘录</h2>
        {candidate.evidence.map((e) => (
          <article className="source-evidence" key={e.id}>
            <h3>{e.title || '网页来源'}</h3>
            {source(e.finalUrl ?? e.sourceUrl, '原始网页')}
            <p>
              采集 {commerceDate(e.observedAt)} · {e.status === 'read' ? '已读取' : '未读取成功'}
            </p>
            {e.excerpts.map((s, i) => (
              <blockquote key={i}>{s}</blockquote>
            ))}
            <details>
              <summary>采集依据与摘要</summary>
              <p>
                {e.sha256} · {e.hashScope}
              </p>
              <p>{e.attribution}</p>
              <p>{Object.values(e.fieldBasis ?? {}).join('；')}</p>
            </details>
          </article>
        ))}
      </section>
      <section className="outbound-card">
        <h2>7. 系统建议</h2>
        <p>{report.recommendation}</p>
      </section>
      <section className="outbound-card">
        <h2>人工修正与审核</h2>
        <p>
          修正作为人工意见单独保存，原始网页证据与规则报告保留。通过后进入本模块已审核企业名单。
        </p>
        <div className="outbound-corrections">
          {Object.entries({
            name: '公司名称',
            country: '国家或地区',
            address: '公开地址',
            business: '主营业务',
            buyerType: '企业类型',
            sourceUrl: '修正来源 URL',
          }).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                aria-label={`修正${label}`}
                value={corrections[key as keyof typeof corrections]}
                onChange={(e) => setCorrections({ ...corrections, [key]: e.target.value })}
                maxLength={
                  key === 'business' || key === 'address'
                    ? 500
                    : key === 'buyerType'
                      ? 120
                      : key === 'country'
                        ? 100
                        : 240
                }
              />
            </label>
          ))}
        </div>
        <label>
          审核备注（必填）
          <textarea
            aria-label="审核备注"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={1000}
            rows={3}
          />
        </label>
        <div className="research-actions">
          {(['approved', 'rejected', 'needs_info'] as const).map((s) => (
            <Button
              key={s}
              variant={s === 'approved' ? 'default' : 'outline'}
              disabled={busy || !notes.trim()}
              onClick={() => void review(s)}
            >
              {s === 'approved' ? '通过' : s === 'rejected' ? '驳回' : '待补充调查'}
            </Button>
          ))}
        </div>
        {error && (
          <p className="research-error" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="research-notice" role="status">
            {message}
          </p>
        )}
        <p>
          审核人：{company.reviewer_name ?? '尚未审核'} · 时间：{commerceDate(company.reviewed_at)}{' '}
          · 版本 {company.revision}
        </p>
        <details>
          <summary>审核与修正历史（最近 30 条）</summary>
          {history.map((h, i) => (
            <article key={i}>
              <p>
                {h.actor} · {commerceDate(h.at)}
              </p>
              <pre>{JSON.stringify(h.details, null, 2)}</pre>
            </article>
          ))}
        </details>
      </section>
    </main>
  );
}
