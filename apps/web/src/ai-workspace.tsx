import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AIRunView, MemberView } from '@zutrade/contracts';
import { Button } from '@zutrade/ui';
import { CommerceApiError, commerceDate, commerceRequest } from './commerce-api';
interface QuoteContext {
  opportunities: { id: string; title: string; factory_id: string | null }[];
  products: { id: string; sku: string; factory_id: string; name: string }[];
}
interface Workspace {
  scenarios: { id: string; input: string; description: string }[];
  scenarioVersion: string;
  businessClock: string;
  faqPolicyReviewed: boolean;
  runs: AIRunView[];
  templatePolicy: { material: string; dimensions: string };
}
export function AIWorkspace({
  member,
  threadId,
  identity,
}: {
  member: MemberView;
  threadId: string;
  identity: string;
}) {
  const cache = useQueryClient(),
    base = `/api/workspaces/${member.workspace_id}/ai`,
    key = ['ai', member.id, threadId];
  const data = useQuery({
    queryKey: key,
    queryFn: () => commerceRequest<Workspace>(`${base}/threads/${threadId}`),
    refetchInterval: 2000,
    retry: false,
  });
  const ctx = useQuery({
    queryKey: ['ai-context', member.id, threadId],
    queryFn: () =>
      commerceRequest<QuoteContext>(
        `/api/workspaces/${member.workspace_id}/quoting/threads/${threadId}`,
      ),
    retry: false,
  });
  const [task, setTask] = useState('answer'),
    [op, setOp] = useState(''),
    [product, setProduct] = useState(''),
    [auto, setAuto] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [editing, setEditing] = useState(''),
    [text, setText] = useState(''),
    [when, setWhen] = useState(''),
    [zone, setZone] = useState('Asia/Shanghai'),
    [simulationText, setSimulationText] = useState('What material is CT-01 made of?');
  const opportunity =
      ctx.data?.opportunities.find((x) => x.id === op) ?? ctx.data?.opportunities[0],
    products = ctx.data?.products.filter((x) => x.factory_id === opportunity?.factory_id) ?? [],
    productId = products.find((x) => x.id === product)?.id ?? products[0]?.id;
  async function act(path: string, body: unknown, message: string) {
    setPending(true);
    setError('');
    setNotice('');
    try {
      await commerceRequest(base + path, body);
      setNotice(message);
      setEditing('');
      await cache.invalidateQueries();
    } catch (e) {
      setError(e instanceof Error ? e.message : '模拟 AI 操作失败');
    } finally {
      setPending(false);
    }
  }
  function decision(r: AIRunView, choice: 'adopt' | 'modify' | 'reject') {
    return act(
      `/runs/${r.id}/decision`,
      {
        commandId: crypto.randomUUID(),
        decision: choice,
        ...(choice === 'modify' ? { editedText: text } : {}),
        ...(r.proposed_action?.followup ? { localTime: when, timeZone: zone } : {}),
      },
      choice === 'reject'
        ? '已拒绝；尚未领取的旧 FAQ 将被网关阻止。'
        : choice === 'modify'
          ? '已保存独立内部草稿；外发需要正常审批。'
          : '已采用建议；采购需求、资料任务或内部草稿已保存。',
    );
  }
  async function inject() {
    setPending(true);
    setError('');
    try {
      const eventId = crypto.randomUUID();
      await commerceRequest(`/api/workspaces/${member.workspace_id}/inbox/simulation`, {
        eventId,
        providerMessageId: eventId,
        identity,
        displayName: '模拟买家 · E 场景',
        body: simulationText,
        occurredAt: new Date().toISOString(),
        factoryId: opportunity?.factory_id,
      });
      setNotice('模拟入站收据已保存；请等待买家消息出现后生成建议。');
      await cache.invalidateQueries();
    } catch (e) {
      setError(e instanceof Error ? e.message : '入站失败');
    } finally {
      setPending(false);
    }
  }
  const accessError = [data.error, ctx.error].find(
    (e) => e instanceof CommerceApiError && [401, 403, 404].includes(e.status),
  );
  if (accessError)
    return (
      <section aria-label="模拟 AI">
        <p role="alert">{accessError.message}</p>
      </section>
    );
  return (
    <section className="ai-panel" aria-label="模拟 AI">
      <h3>
        模拟 AI <small>预设场景 · 仅团队可见</small>
      </h3>
      <p>
        读取最新买家消息。仅支持 CT-01
        的固定表达；未知输入转人工。建议不具有事实发布、批准或发送权限。
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {data.isError && <p role="alert">{data.error.message}</p>}
      {ctx.isError && <p role="alert">{ctx.error.message}</p>}
      <details>
        <summary>适用场景与固定业务时钟</summary>
        <p>
          {data.data?.scenarioVersion} · {data.data?.businessClock}
          。真实有效期和发送门槛仍按数据库当前时间判断。
        </p>
        {data.data?.scenarios.map((s) => (
          <p key={s.id}>
            <code>{s.input}</code>
            <br />
            {s.description}
          </p>
        ))}
      </details>
      {member.role === 'owner' && (
        <details>
          <summary>场景调试 · 注入模拟买家消息</summary>
          <p>通过既有入站收据与 worker 修改当前会话上下文；不会发送真实消息。</p>
          <label>
            预设入站场景
            <select
              onChange={(e) => setSimulationText(e.target.value)}
              value={
                data.data?.scenarios.some((x) => x.input === simulationText) ? simulationText : ''
              }
            >
              <option value="">自定义未知输入</option>
              {data.data?.scenarios.map((s) => (
                <option key={s.id} value={s.input}>
                  {s.id} · {s.description}
                </option>
              ))}
            </select>
          </label>
          <label>
            模拟买家消息内容
            <textarea value={simulationText} onChange={(e) => setSimulationText(e.target.value)} />
          </label>
          <Button
            disabled={pending || !identity || !simulationText.trim() || !opportunity?.factory_id}
            onClick={() => void inject()}
          >
            注入所选场景买家消息
          </Button>
        </details>
      )}
      <div className="ai-controls">
        <label>
          AI 关联商机
          <select
            value={opportunity?.id ?? ''}
            onChange={(e) => {
              setOp(e.target.value);
              setProduct('');
            }}
          >
            {ctx.data?.opportunities.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          AI 关联产品
          <select value={productId ?? ''} onChange={(e) => setProduct(e.target.value)}>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.sku} · {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          建议类型
          <select value={task} onChange={(e) => setTask(e.target.value)}>
            <option value="answer">普通问答</option>
            <option value="requirements">需求提取</option>
            <option value="retrieval">资料检索请求</option>
            <option value="quote_input">报价输入</option>
            <option value="followup">跟进建议</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          条件满足时通过统一网关自动模拟 FAQ
        </label>
        <Button
          disabled={pending || !productId || !opportunity}
          onClick={() =>
            void act(
              `/threads/${threadId}/runs`,
              {
                commandId: crypto.randomUUID(),
                opportunityId: opportunity!.id,
                productId,
                task,
                autoFaq: auto,
              },
              '模拟 AI 任务已提交；可取消或等待真实 worker 结果。',
            )
          }
        >
          生成模拟建议
        </Button>
      </div>
      <details>
        <summary>受控 FAQ 模板审核 · {data.data?.faqPolicyReviewed ? '已审核' : '未启用'}</summary>
        <p>
          仅材质与尺寸。审核固定模板及允许值：材质 12oz / 12oz cotton / 12oz cotton canvas；尺寸
          35×40cm。不含价格、折扣、交期或样品费。
        </p>
        <p>
          {data.data?.templatePolicy.material}
          <br />
          {data.data?.templatePolicy.dimensions}
        </p>
        {member.id === member.approver_member_id && member.role === 'owner' && (
          <div className="action-row">
            <Button
              disabled={pending}
              onClick={() =>
                void act('/faq-policy', { enabled: true }, '当前指定 owner 已审核 FAQ 模板。')
              }
            >
              审核并启用 FAQ 模板
            </Button>
            <Button
              disabled={pending}
              onClick={() =>
                void act('/faq-policy', { enabled: false }, 'FAQ 模板已停用，旧自动动作将被阻止。')
              }
            >
              停用 FAQ 模板
            </Button>
          </div>
        )}
      </details>
      {!data.data?.runs.length && (
        <p>尚无模拟 AI 运行。生成后保留输入引用、场景版本、证据、输出及校验记录。</p>
      )}
      {data.data?.runs.map((r) => (
        <article className="ai-run" key={r.id} data-ai-run={r.id}>
          <strong>
            {r.scenario_id} · {r.scenario_version} ·{' '}
            {r.state === 'running'
              ? '生成中'
              : r.state === 'cancelled'
                ? '已取消'
                : r.state === 'failed'
                  ? '失败'
                  : r.proposed_action?.status === 'needs_human'
                    ? '需转人工'
                    : '建议已生成'}
          </strong>
          <small>
            {commerceDate(r.started_at)} ·{' '}
            {r.duration_ms === null ? '耗时尚未记录' : `${r.duration_ms} ms`} · token/费用：不适用
          </small>
          <p>{r.proposed_action?.summary ?? r.error_detail ?? '等待任务结果'}</p>
          {r.faqAction && (
            <p role="status">
              模拟 FAQ：
              {(
                {
                  queued: '等待网关',
                  simulated: '模拟执行完成',
                  blocked: '已阻止',
                  failed: '失败',
                  unknown: '结果待核对',
                } as Record<string, string>
              )[r.faqAction.status] ?? r.faqAction.status}{' '}
              {r.faqAction.reason}
            </p>
          )}
          {r.proposed_action?.requiresApproval && <p>商业承诺须工厂确认及指定 owner 正常审批。</p>}
          {(r.staleReason || r.validation_result?.reason) && (
            <p role="status">{r.staleReason ?? r.validation_result?.reason}</p>
          )}
          {r.proposed_action?.evidence.map((e, i) => (
            <details key={i}>
              <summary>事实来源 · {e.locator}</summary>
              <p>{e.excerpt}</p>
              <p>
                事实版本 {e.factVersionId}
                <br />
                来源版本 {e.sourceVersionId}
                <br />
                SHA256 {e.sourceSha256}
              </p>
            </details>
          ))}
          <details>
            <summary>输入引用与输出校验</summary>
            <p>
              输入摘要 {r.input_references.contextHash}
              <br />
              消息 {r.input_references.input.context.messageId}
              <br />
              会话修订 {r.input_references.input.context.threadRevision} · 需求修订{' '}
              {r.input_references.input.context.requirementsRevision}
            </p>
            <p>{r.input_references.input.text}</p>
            <pre>{JSON.stringify(r.validation_result, null, 2)}</pre>
          </details>
          {r.state === 'running' && (
            <Button
              disabled={pending}
              onClick={() => void act(`/runs/${r.id}/cancel`, {}, '取消已记录；迟到结果不会覆盖。')}
            >
              取消生成
            </Button>
          )}
          {r.decision && (
            <p>
              已处理：{r.decision} {r.decision_text}
              <br />
              {String(r.decision_result?.next ?? '')}
            </p>
          )}
          {r.state === 'succeeded' && !r.decision && (
            <>
              <div className="action-row">
                <Button
                  disabled={pending || !r.current || Boolean(r.proposed_action?.followup && !when)}
                  onClick={() => void decision(r, 'adopt')}
                >
                  采用建议
                </Button>
                <Button
                  disabled={pending || !r.current}
                  onClick={() => {
                    setEditing(r.id);
                    setText(r.proposed_action?.summary ?? '');
                  }}
                >
                  修改为内部草稿
                </Button>
                <Button disabled={pending} onClick={() => void decision(r, 'reject')}>
                  拒绝建议
                </Button>
              </div>
              {r.proposed_action?.followup && (
                <div>
                  <p>
                    场景建议时间：{r.proposed_action.followup.suggestedAt}；采用需明确未来提醒时间。
                  </p>
                  <label>
                    AI 跟进到期时间
                    <input
                      type="datetime-local"
                      value={when}
                      onChange={(e) => setWhen(e.target.value)}
                    />
                  </label>
                  <label>
                    AI 跟进时区
                    <input value={zone} onChange={(e) => setZone(e.target.value)} />
                  </label>
                </div>
              )}
              {editing === r.id && (
                <div>
                  <label>
                    修改 AI 建议
                    <textarea value={text} onChange={(e) => setText(e.target.value)} />
                  </label>
                  <Button
                    disabled={pending || !text.trim()}
                    onClick={() => void decision(r, 'modify')}
                  >
                    保存修改草稿
                  </Button>
                </div>
              )}
            </>
          )}
        </article>
      ))}
    </section>
  );
}
