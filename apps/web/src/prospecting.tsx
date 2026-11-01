import { useEffect, useState, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, ExternalLink, X, FileSearch, RotateCw } from 'lucide-react';
import { Button } from '@zutrade/ui';
import type {
  MemberView,
  FactoryView,
  ResearchRequest,
  ResearchRunView,
  ResearchDetail,
  ResearchOptions,
  ResearchCandidate,
} from '@zutrade/contracts';
import { commerceDate, commerceRequest, CommerceApiError } from './commerce-api';

const labels: Record<string, string> = {
  queued: '等待 worker',
  running: '正在读取公开来源',
  completed: '研究完成',
  partial: '部分完成',
  failed: '研究失败',
  cancelled: '已取消',
};
const errors: Record<string, string> = {
  SSRF_DNS_REJECTED: 'DNS 返回了私网或保留地址，已安全拒绝；请检查本机代理/VPN DNS。',
  SSRF_ADDRESS_REJECTED: '来源地址不是允许的公网地址。',
  REQUEST_TIMEOUT: '来源读取超时。',
  RUN_DEADLINE: '已到固定研究截止时间，保留已获取结果。',
  REQUEST_BUDGET_EXHAUSTED: '本次累计请求预算已耗尽。',
  HTTP_429: '来源限流，未绕过限制。',
  HTTP_403: '来源拒绝访问。',
  DIRECTORY_API_ERROR: '目录服务返回错误。',
};
function sourceLink(url: string, label: string) {
  try {
    const u = new URL(url);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password)
      return <span>不安全的来源链接</span>;
  } catch {
    return null;
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {label} <ExternalLink size={12} />
    </a>
  );
}
export function ProspectingPanel({ member }: { member: MemberView }) {
  const resultsRef = useRef<HTMLElement>(null);
  const cache = useQueryClient();
  const base = `/api/workspaces/${member.workspace_id}/prospecting`;
  const [factory, setFactory] = useState(''),
    [product, setProduct] = useState('');
  const [directory, setDirectory] = useState<ResearchRequest['directoryId']>('wikimedia-events-sg');
  const [provider, setProvider] = useState<ResearchRequest['provider']>('public_directory');
  const [country, setCountry] = useState<ResearchRequest['country']>('SG');
  const [buyerType, setBuyerType] = useState('event management'),
    [keywords, setKeywords] = useState('events, promotional'),
    [exclusions, setExclusions] = useState(''),
    [limit, setLimit] = useState(20);
  const [selected, setSelected] = useState(''),
    [candidateKey, setCandidateKey] = useState('');
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [buyerId, setBuyerId] = useState('');
  const options = useQuery({
    queryKey: ['prospecting-options', member.id],
    queryFn: () => commerceRequest<ResearchOptions>(`${base}/options`),
  });
  const factories = useQuery({
    queryKey: ['factories', member.id],
    queryFn: () =>
      commerceRequest<FactoryView[]>(`/api/workspaces/${member.workspace_id}/factories`),
  });
  const products = useQuery({
    queryKey: ['research-products', member.id],
    queryFn: () =>
      commerceRequest<{ items: { id: string; factory_id: string; name: string; sku: string }[] }>(
        `/api/workspaces/${member.workspace_id}/supply/products`,
      ),
  });
  const runs = useQuery({
    queryKey: ['research-runs', member.id],
    queryFn: () => commerceRequest<ResearchRunView[]>(`${base}/runs`),
    refetchInterval: 2500,
    retry: false,
  });
  const detail = useQuery({
    queryKey: ['research-detail', member.id, selected],
    queryFn: () => commerceRequest<ResearchDetail>(`${base}/runs/${selected}`),
    enabled: Boolean(selected),
    refetchInterval: 2500,
    retry: false,
  });
  useEffect(() => {
    if (!factory && factories.data?.[0]) setFactory(factories.data[0].id);
  }, [factory, factories.data]);
  useEffect(() => {
    if (!selected && runs.data?.[0]) setSelected(runs.data[0].id);
  }, [selected, runs.data]);
  useEffect(() => {
    setCandidateKey('');
    setReason('');
    setConfirmed(false);
    setBuyerId('');
    if (window.matchMedia('(max-width: 700px)').matches)
      resultsRef.current?.scrollIntoView({ block: 'start' });
  }, [selected]);
  useEffect(() => {
    setReason('');
    setConfirmed(false);
    setBuyerId('');
  }, [candidateKey]);
  const blocked = [runs.error, detail.error, factories.error].some(
    (e) => e instanceof CommerceApiError && [401, 403, 404].includes(e.status),
  );
  const run = blocked ? undefined : detail.data?.run;
  const candidate = run?.results_snapshot.candidates.find((c) => c.key === candidateKey);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : '请求失败');
    } finally {
      await cache.invalidateQueries({ queryKey: ['research-runs', member.id] });
      await cache.invalidateQueries({ queryKey: ['research-detail', member.id, selected] });
      setBusy(false);
    }
  }
  const words = (value: string) =>
    value
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
  async function start() {
    await act(async () => {
      const result = await commerceRequest<{ runId: string }>(`${base}/runs`, {
        commandId: crypto.randomUUID(),
        factoryId: factory,
        productId: product || null,
        provider,
        directoryId: directory,
        country,
        buyerType,
        keywords: words(keywords),
        exclusions: words(exclusions),
        limit,
      });
      setSelected(result.runId);
    });
  }
  function reuse(r: ResearchRunView) {
    setFactory(r.request.factoryId);
    setProduct(r.request.productId ?? '');
    setProvider(r.request.provider);
    setDirectory(r.request.directoryId);
    setCountry(r.request.country);
    setBuyerType(r.request.buyerType);
    setKeywords(r.request.keywords.join(', '));
    setExclusions(r.request.exclusions.join(', '));
    setLimit(r.request.limit);
    setMessage('已载入原条件。点击“开始真实研究”创建新任务，历史证据保留。');
  }
  async function review(decision: 'keep' | 'exclude') {
    if (!run || !candidate) return;
    await act(async () => {
      await commerceRequest(`${base}/runs/${run.id}/review`, {
        candidateKey: candidate.key,
        resultVersion: run.result_version,
        reviewRevision: run.review_revision,
        decision,
        reason,
      });
      setMessage(
        decision === 'keep' ? '候选已保留，请确认公司身份后导入。' : '已排除候选并保存原因。',
      );
      setConfirmed(false);
    });
  }
  const bad =
    error ||
    (runs.error?.message ?? '') ||
    (detail.error?.message ?? '') ||
    (options.error?.message ?? '');
  return (
    <main className="prospecting-panel">
      <div className="research-heading">
        <div>
          <div className="eyebrow">PUBLIC COMPANY RESEARCH</div>
          <h1>找客户</h1>
          <p>选择代表工厂，读取公开目录，再逐项核对公司身份与来源。</p>
        </div>
        <span className="research-live">企业发现 · 真实网络</span>
      </div>
      <div className="research-layout">
        <aside className="research-sidebar">
          <form
            className="research-form"
            onSubmit={(e) => {
              e.preventDefault();
              void start();
            }}
          >
            <h2>
              <Search size={18} /> 新建研究
            </h2>
            <label>
              代表工厂
              <select
                value={factory}
                onChange={(e) => {
                  setFactory(e.target.value);
                  setProduct('');
                }}
                required
              >
                <option value="">选择工厂</option>
                {factories.data?.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.factory_code} · {f.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              代表产品
              <select value={product} onChange={(e) => setProduct(e.target.value)}>
                <option value="">工厂级研究（未指定产品）</option>
                {products.data?.items
                  .filter((p) => p.factory_id === factory)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.sku} · {p.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              发现方式
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as ResearchRequest['provider'])}
              >
                <option value="public_directory">公开目录 · 无需搜索账号</option>
                <option value="brave_search" disabled={!options.data?.brave.enabled}>
                  Brave 关键词搜索{options.data?.brave.enabled ? '' : ' · 未启用'}
                </option>
              </select>
            </label>
            <p className="research-help">{options.data?.brave.detail}</p>
            {provider === 'public_directory' ? (
              <>
                <label>
                  公开目录
                  <select
                    value={directory}
                    onChange={(e) => {
                      setDirectory(e.target.value as ResearchRequest['directoryId']);
                      const d = options.data?.directories.find((d) => d.id === e.target.value);
                      if (d) setCountry(d.country as ResearchRequest['country']);
                    }}
                  >
                    {options.data?.directories.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="research-help">
                  {options.data?.directories.find((d) => d.id === directory)?.coverage}
                  {options.data?.directories.find((d) => d.id === directory)?.source &&
                    sourceLink(
                      options.data.directories.find((d) => d.id === directory)!.source,
                      '查看公开目录',
                    )}
                </p>
              </>
            ) : (
              <label>
                目标地区
                <select
                  value={country}
                  onChange={(e) => setCountry(e.target.value as ResearchRequest['country'])}
                >
                  <option value="SG">新加坡</option>
                  <option value="GB">英国</option>
                  <option value="AU">澳大利亚</option>
                </select>
              </label>
            )}
            <label>
              买家类型
              <input
                value={buyerType}
                onChange={(e) => setBuyerType(e.target.value)}
                maxLength={120}
                required
              />
            </label>
            <label>
              业务关键词（逗号分隔）
              <input value={keywords} onChange={(e) => setKeywords(e.target.value)} />
            </label>
            <label>
              排除词（逗号分隔）
              <input value={exclusions} onChange={(e) => setExclusions(e.target.value)} />
            </label>
            <label>
              候选上限
              <input
                type="number"
                min={1}
                max={50}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                required
              />
            </label>
            <p className="research-help">
              默认 20 家 · 最多 50 家 · 总请求 80 次 · 固定 180
              秒。目录模式按所选名录发现，关键词用于证据匹配，不执行全网关键词搜索。
            </p>
            <Button disabled={busy || !factory || !options.data || blocked} type="submit">
              {busy ? '正在提交…' : '开始真实研究'}
            </Button>
          </form>
          <section className="research-history">
            <h2>最近研究</h2>
            {runs.isPending ? (
              <p>正在读取…</p>
            ) : !runs.data?.length ? (
              <p>尚无研究任务</p>
            ) : (
              runs.data.map((r) => (
                <button
                  key={r.id}
                  data-run-id={r.id}
                  className={`research-run ${selected === r.id ? 'selected' : ''}`}
                  onClick={() => {
                    setSelected(r.id);
                    setError('');
                  }}
                >
                  <strong>
                    {r.request.country} · {r.request.buyerType}
                  </strong>
                  <span>
                    {labels[r.state]} · {r.candidate_count} 家
                  </span>
                  <small>{commerceDate(r.created_at)}</small>
                </button>
              ))
            )}
          </section>
        </aside>
        <section className="research-results" ref={resultsRef}>
          {bad && (
            <p role="alert" className="research-error">
              {bad}
            </p>
          )}
          {message && (
            <p role="status" className="research-notice">
              {message}
            </p>
          )}
          {!run ? (
            <div className="research-empty">
              <FileSearch size={38} />
              <h2>{detail.isFetching ? '正在读取研究…' : '从公开来源开始'}</h2>
              <p>不会生成模拟公司或推断采购意愿。消息保持 simulation，AI 保持 mock。</p>
            </div>
          ) : (
            <>
              <div className="research-run-heading">
                <div>
                  <h2>{labels[run.state]}</h2>
                  <p>
                    {run.request.country} · {run.request.buyerType} ·{' '}
                    {run.provider === 'public_directory' ? '公开目录' : 'Brave Search'}
                  </p>
                </div>
                <Button variant="outline" disabled={busy} onClick={() => reuse(run)}>
                  <RotateCw size={14} /> 重新研究
                </Button>
                {!run.finished_at && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await commerceRequest(`${base}/runs/${run.id}/cancel`, {});
                      })
                    }
                  >
                    取消研究
                  </Button>
                )}
              </div>
              <div className="research-meta">
                <span>
                  {run.data_origin === 'offline_fixture' ? '离线测试数据' : '来自真实网络任务'}
                </span>
                <span>
                  {run.candidate_count} 家候选 · 累计 {run.request_count}/80 次请求
                </span>
                <span>开始 {commerceDate(run.first_started_at)}</span>
                <span>截止 {commerceDate(run.deadline)}</span>
              </div>
              {run.error && (
                <p className="research-error" role="alert">
                  {errors[run.error] ?? run.error}
                  <small>已保存原条件和执行状态。重新研究会创建新任务。</small>
                </p>
              )}
              <p className="research-help">
                得分只表示规则符合度。目录/摘要待复核；未知所在地、联系人及营销许可保持未知。
              </p>
              {!run.results_snapshot.candidates.length ? (
                <div className="research-empty">
                  <FileSearch size={30} />
                  <h3>{run.finished_at ? '本次未取得候选' : '等待公开来源响应'}</h3>
                  <p>{run.error ? '没有用预置公司补齐结果。' : '任务完成后可查看候选和证据。'}</p>
                </div>
              ) : (
                <div className="candidate-list">
                  {run.results_snapshot.candidates.map((c) => (
                    <article className="candidate-card" key={c.key}>
                      <div>
                        <h3>{c.name}</h3>
                        <p>{c.description || '业务描述未知'}</p>
                        <span>
                          {c.country ?? '所在地未知'} · {c.domain ?? '官网域名未知'}
                        </span>
                      </div>
                      <div className="candidate-status">
                        <strong>{c.score} 分</strong>
                        <span>
                          {run.review_decisions[c.key]?.decision === 'exclude'
                            ? '已排除'
                            : run.review_decisions[c.key]?.decision === 'keep'
                              ? '已保留'
                              : '待人工复核'}
                        </span>
                        {detail.data?.imported[c.key] && <span>已导入线索</span>}
                        {Boolean(detail.data?.duplicates[c.key]?.length) && (
                          <span>可能已有记录 · 请核对</span>
                        )}
                        <Button variant="outline" onClick={() => setCandidateKey(c.key)}>
                          核对来源
                        </Button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
              <details className="research-audit">
                <summary>来源错误与研究身份</summary>
                <p>
                  任务 {run.id} · 结果 v{run.result_version} · 审核 v{run.review_revision} · 执行 v
                  {run.execution_version}
                </p>
                {run.results_snapshot.errors.map((e, i) => (
                  <p key={i}>
                    {e.code} · {e.url}
                  </p>
                ))}
                <p>请求摘要 {run.request_sha256}</p>
                <p>消息 simulation · AI mock/preset · 不具备真实触达授权</p>
              </details>
            </>
          )}
        </section>
      </div>
      {candidate && run && (
        <div className="research-overlay" onClick={() => setCandidateKey('')}>
          <section
            className="source-drawer"
            aria-label="候选来源"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="research-run-heading">
              <div>
                <div className="eyebrow">SOURCE REVIEW</div>
                <h2>{candidate.name}</h2>
              </div>
              <button
                className="settings-button"
                aria-label="关闭来源"
                onClick={() => setCandidateKey('')}
              >
                <X size={20} />
              </button>
            </div>
            <p>来源复核与公司身份确认是线索导入的必要步骤。公开信息不表示采购意向或营销许可。</p>
            {bad && (
              <p role="alert" className="research-error">
                {bad}
              </p>
            )}
            {message && (
              <p role="status" className="research-notice">
                {message}
              </p>
            )}
            <p>
              {sourceLink(candidate.sourceUrl, '打开公司目录来源')}
              {candidate.website && (
                <>
                  {' '}
                  ·{' '}
                  {sourceLink(
                    candidate.website,
                    candidate.evidence.some(
                      (e) => e.kind === 'official_website' && e.status === 'read',
                    )
                      ? '打开已读取的官网来源'
                      : '打开所列官网（未读取成功）',
                  )}
                </>
              )}
            </p>
            <EvidenceList candidate={candidate} />
            <section>
              <h3>匹配依据 · {candidate.score} 分</h3>
              {candidate.reasons.length ? (
                candidate.reasons.map((r, i) => (
                  <p key={i}>
                    {r.points > 0 ? '+' : ''}
                    {r.points} · {r.detail}
                    <small>
                      证据 {r.evidenceId.slice(0, 12)} · {candidate.rulesVersion}
                    </small>
                  </p>
                ))
              ) : (
                <p>暂无有证据的匹配规则</p>
              )}
              <p>未知：{candidate.unknownFields.join('、')}</p>
            </section>
            {run.review_decisions[candidate.key] && (
              <p className="research-notice">
                {run.review_decisions[candidate.key]?.decision === 'keep' ? '已保留' : '已排除'}：
                {run.review_decisions[candidate.key]?.reason} ·{' '}
                {commerceDate(run.review_decisions[candidate.key]?.at)}
              </p>
            )}
            <label>
              审核原因
              <textarea
                aria-label="审核原因"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                placeholder="记录核对了哪个来源、身份判断或排除原因"
              />
            </label>
            <div className="research-actions">
              <Button
                disabled={busy || !run.finished_at || !reason.trim()}
                onClick={() => void review('keep')}
              >
                保留候选
              </Button>
              <Button
                variant="outline"
                disabled={busy || !run.finished_at || !reason.trim()}
                onClick={() => void review('exclude')}
              >
                排除候选
              </Button>
            </div>
            <section className="research-import">
              <h3>确认并导入线索</h3>
              <p>只创建公司线索；不自动创建联系人、验证邮箱或赋予营销资格。</p>
              <label>
                买家关联
                <select value={buyerId} onChange={(e) => setBuyerId(e.target.value)}>
                  <option value="">新建独立买家公司</option>
                  {detail.data?.duplicates[candidate.key]?.map((b) => (
                    <option key={b.id} value={b.id}>
                      关联已有：{b.name} · {b.domain ?? '域名未知'}
                    </option>
                  ))}
                </select>
              </label>
              {Boolean(detail.data?.duplicates[candidate.key]?.length) && (
                <p>名称/域名相似仅为重复建议，请确认是否为同一实体。</p>
              )}
              <label className="research-checkbox">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                我已打开来源，核对公司身份及买家关联选择
              </label>
              <Button
                disabled={
                  busy || !confirmed || run.review_decisions[candidate.key]?.decision !== 'keep'
                }
                onClick={() =>
                  void act(async () => {
                    const r = await commerceRequest<{ leadId: string }>(
                      `${base}/runs/${run.id}/import`,
                      {
                        commandId: crypto.randomUUID(),
                        candidateKey: candidate.key,
                        resultVersion: run.result_version,
                        reviewRevision: run.review_revision,
                        buyerId: buyerId || null,
                        identityConfirmed: true,
                      },
                    );
                    setMessage(`线索已保存 · ${r.leadId}`);
                  })
                }
              >
                {detail.data?.imported[candidate.key] ? '再次导入（返回原线索）' : '确认身份并导入'}
              </Button>
            </section>
          </section>
        </div>
      )}
    </main>
  );
}
function EvidenceList({ candidate }: { candidate: ResearchCandidate }) {
  return (
    <div>
      {candidate.evidence.map((e) => (
        <article className="source-evidence" key={e.id}>
          <h3>
            {e.kind === 'official_website'
              ? e.status === 'read'
                ? '官网已读取'
                : '官网来源'
              : e.kind === 'search_summary'
                ? '搜索摘要 · 待复核'
                : '目录证据 · 待复核'}{' '}
            · {e.status === 'read' ? '已读取' : e.status === 'blocked' ? '访问受限' : '未读取成功'}
          </h3>
          <p>
            {sourceLink(e.sourceUrl, '原始来源')}
            {e.finalUrl && e.finalUrl !== e.sourceUrl && (
              <> · {sourceLink(e.finalUrl, '最终地址')}</>
            )}
          </p>
          <p>
            实际获取 {commerceDate(e.observedAt)} <small>{e.observedAt} UTC</small>
          </p>
          {e.excerpts.map((s, i) => (
            <blockquote key={i}>{s}</blockquote>
          ))}
          {e.error && <p>{e.error}</p>}
          <p>支持字段：{e.fields.join('、') || '未知'}</p>
          {e.fieldBasis && (
            <details>
              <summary>字段定位依据</summary>
              {Object.entries(e.fieldBasis).map(([field, basis]) => (
                <p key={field}>
                  {field}：{basis}
                </p>
              ))}
            </details>
          )}
          <details>
            <summary>发现链、摘要与署名</summary>
            {e.discoveryChain.map((s, i) => (
              <p key={i}>{sourceLink(s, `${i + 1}. ${s}`)}</p>
            ))}
            <p>
              {e.sha256 ?? '未获取正文，无 hash'} · {e.hashScope ?? '无正文摘要范围'} ·{' '}
              {e.extractorVersion}
            </p>
            <p>{e.attribution}</p>
          </details>
        </article>
      ))}
    </div>
  );
}
