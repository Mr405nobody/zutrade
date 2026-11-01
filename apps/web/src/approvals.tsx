import { useState, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MemberView, OutboundView } from '@zutrade/contracts';
import { Button } from '@zutrade/ui';
import { commerceRequest, commerceDate } from './commerce-api';
const currentApproval = (item: OutboundView | undefined | null) =>
  item?.approvals.find((a) => a.payload_version_id === item.payload.id);
const intentLabel = (intent: string) =>
  ({ quote: '报价', human_reply: '人工回复', outreach: '批次触达', followup: '自动模拟跟进' })[
    intent
  ] ?? intent;
const status: Record<string, string> = {
  awaiting_approval: '等待 owner 审批',
  queued: '已批准，等待模拟执行',
  claimed: '已领取发送权',
  dispatching: '模拟执行中',
  simulated: '模拟执行完成',
  unknown: '结果未知 · 待核对',
  cancelled: '领取前已撤销',
  blocked: '已阻止',
  failed: '渠道明确拒绝',
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
  revoked: '已撤销审批',
  expired: '审批已过期',
  invalidated: '审批已失效',
  requested: '申请审批',
  revocation_too_late: '已过撤销截止点',
};
export function ApprovalPanel({
  member,
  threadId,
  quoteVersionId,
  contextRevision,
}: {
  member: MemberView;
  threadId?: string;
  quoteVersionId?: string | null;
  contextRevision?: string;
}) {
  const base = `/api/workspaces/${member.workspace_id}/dispatch`,
    cache = useQueryClient();
  const key = ['approvals', member.id, threadId ?? 'tasks'];
  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      commerceRequest<{ items: OutboundView[] }>(
        `${base}/${threadId ? `threads/${threadId}` : 'tasks'}`,
      ),
    retry: false,
    refetchInterval: 2000,
  });
  const [pending, setPending] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [body, setBody] = useState(''),
    [intro, setIntro] = useState('standard');
  // Opening an item captures the version actually viewed. Polling must never silently
  // rebind the owner's decision button to a newer target or row version.
  const [view, setView] = useState<OutboundView | null>(null),
    [reason, setReason] = useState('');
  const command = useRef<{ fingerprint: string; id: string } | null>(null);
  function commandId(fingerprint: string) {
    if (command.current?.fingerprint !== fingerprint)
      command.current = { fingerprint, id: crypto.randomUUID() };
    return command.current.id;
  }
  async function mutate(path: string, input: object, label: string) {
    setPending(label);
    setError('');
    setNotice('');
    try {
      const result = await commerceRequest<{ state?: string }>(path, {
        ...input,
        commandId: commandId(JSON.stringify({ path, input })),
      });
      setNotice(
        result.state === 'cancel_requested'
          ? '取消申请已记录；本次可能已被接受，请核对。'
          : result.state === 'cancelled'
            ? '已在领取发送权前撤销。'
            : '操作已保存，请查看审批与执行状态。',
      );
      await cache.invalidateQueries({ queryKey: ['approvals'] });
      await cache.invalidateQueries({ queryKey: ['inbox'] });
      const fresh = await query.refetch();
      const same = fresh.data?.items.find(
        (x) => x.request.id === view?.request.id && x.payload.id === view.payload.id,
      );
      if (same)
        setView((current) =>
          current?.request.id === same.request.id && current.payload.id === same.payload.id
            ? same
            : current,
        );
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setPending('');
    }
  }
  async function prepare(kind: 'quote' | 'human_reply', existing?: OutboundView) {
    if (!threadId || !contextRevision) return;
    const input = {
      kind,
      contextRevision,
      quoteVersionId:
        kind === 'quote' ? (quoteVersionId ?? existing?.payload.quote_version_id ?? null) : null,
      introduction: intro,
      ...(kind === 'human_reply' ? { body: body || existing?.payload.body_text || '' } : {}),
      ...(existing
        ? { requestId: existing.request.id, expectedVersion: existing.request.row_version }
        : {}),
    };
    await mutate(`${base}/threads/${threadId}/prepare`, input, 'prepare');
  }
  useEffect(() => {
    if (
      view &&
      (query.isError ||
        (query.data && !query.data.items.some((x) => x.request.id === view.request.id)))
    )
      setView(null);
  }, [query.data, query.isError, view]);
  const active = view ? query.data?.items.find((x) => x.request.id === view.request.id) : null;
  const a = view?.approvals.find((x) => x.payload_version_id === view.payload.id);
  const canApprove = member.role === 'owner' && member.approver_member_id === member.id;
  async function decision(value: 'approve' | 'reject' | 'revoke') {
    if (!view || !a) return;
    await mutate(
      `${base}/approvals/${a.id}/decision`,
      {
        payloadId: view.payload.id,
        snapshotSha256: view.payload.snapshot_sha256,
        expectedVersion: a.row_version,
        decision: value,
        reason,
      },
      value,
    );
  }
  async function reconcile(action: 'lookup' | 'stop' | 'safe_retry') {
    if (!active) return;
    await mutate(
      `${base}/requests/${active.request.id}/reconcile`,
      { expectedVersion: active.request.row_version, action },
      action,
    );
  }
  async function pdf() {
    if (!view) return;
    setError('');
    try {
      const response = await fetch(
        `${base}/requests/${view.request.id}/payloads/${view.payload.id}/pdf`,
        { credentials: 'include' },
      );
      if (!response.ok) {
        const e = (await response.json()) as { message: string };
        throw new Error(e.message);
      }
      const url = URL.createObjectURL(await response.blob());
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      setError(`PDF 异常：${(e as Error).message}`);
    }
  }
  return (
    <section className="approval-panel" aria-label={threadId ? '审批与模拟执行' : '审批待办'}>
      <h3>{threadId ? '审批与模拟执行' : '审批与结果核对待办'}</h3>
      <p className="team-caption">
        仅 simulation。owner 也需要明确审批。自由文本由指定 owner
        人工审阅；程序核验版本、身份、依据与权限。
      </p>
      {threadId && (
        <details className="approval-compose">
          <summary>准备最终内容并提交审批</summary>
          <label>
            报价开场
            <select value={intro} onChange={(e) => setIntro(e.target.value)}>
              <option value="standard">请查看报价与附件</option>
              <option value="thanks">感谢确认采购需求</option>
            </select>
          </label>
          <Button disabled={!!pending || !quoteVersionId} onClick={() => void prepare('quote')}>
            提交当前报价审批
          </Button>
          {!quoteVersionId && <p>请先选取有效报价并生成对应 PDF。</p>}
          <label>
            最终自由文本
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="最终外发正文；未知语义交由 owner 审阅"
            />
          </label>
          <Button
            variant="outline"
            disabled={!!pending || !body.trim()}
            onClick={() => void prepare('human_reply')}
          >
            提交自由文本审批
          </Button>
        </details>
      )}
      {error && (
        <div role="alert" className="commerce-error">
          {error}{' '}
          <button
            className="text-button"
            onClick={() => {
              setView(active ?? null);
              setError('');
            }}
          >
            重新查看最新版本
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {query.isError ? (
        <p role="alert">{query.error.message}</p>
      ) : query.isPending ? (
        <p>正在读取审批…</p>
      ) : !query.data.items.length ? (
        <p className="commerce-empty">暂无审批请求。</p>
      ) : (
        <div className="approval-list">
          {query.data.items.map((x) => (
            <button
              className={`approval-row ${view?.request.id === x.request.id ? 'selected' : ''}`}
              key={x.request.id}
              onClick={() => {
                setView(x);
                setReason('');
                setError('');
              }}
            >
              <strong>
                {intentLabel(x.request.intent)} · v{x.payload.version_no}
              </strong>
              <span>{x.payload.recipients_snapshot[0]?.identity}</span>
              <span>{status[x.request.state] ?? x.request.state}</span>
              <span>
                {currentApproval(x) ? status[currentApproval(x)!.state] : ''}
                {x.request.cancel_requested_at ? ' · 已请求取消' : ''}
              </span>
              <small>{x.request.stop_reason}</small>
            </button>
          ))}
        </div>
      )}
      {view && (
        <article className="approval-preview" aria-label="最终外发内容预览">
          <div className="commerce-toolbar">
            <h4>
              已查看 v{view.payload.version_no} · {intentLabel(view.request.intent)}
            </h4>
            <Button variant="outline" onClick={() => setView(null)}>
              关闭预览
            </Button>
          </div>
          {active &&
            (active.payload.id !== view.payload.id ||
              currentApproval(active)?.row_version !== currentApproval(view)?.row_version) && (
              <div role="alert" className="commerce-error">
                版本或审批状态已变化。当前按钮仍绑定已查看版本，请重新查看。
                <Button variant="outline" onClick={() => setView(active)}>
                  重新查看最新版本
                </Button>
              </div>
            )}
          <p>收件人：{view.payload.recipients_snapshot.map((r) => r.identity).join(', ')}</p>
          {view.payload.subject && (
            <p>
              <strong>主题：{view.payload.subject}</strong>
            </p>
          )}
          <pre className="approval-body">{view.payload.body_text}</pre>
          {view.payload.attachment_manifest.map((f) => (
            <p key={f.sha256}>
              <Button variant="outline" onClick={() => void pdf()}>
                查看已保存 PDF
              </Button>{' '}
              {f.filename}
            </p>
          ))}
          {a && (
            <p>
              审批：{status[a.state] ?? a.state} · 有效至 {commerceDate(a.expires_at)}
              {a.reason ? ` · ${a.reason}` : ''}
            </p>
          )}
          {canApprove && a && (
            <>
              <label>
                审批说明
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={1000}
                />
              </label>
              <div className="commerce-toolbar">
                {a.state === 'pending' && (
                  <>
                    <Button disabled={!!pending} onClick={() => void decision('approve')}>
                      批准并模拟执行
                    </Button>
                    <Button
                      variant="outline"
                      disabled={!!pending}
                      onClick={() => void decision('reject')}
                    >
                      拒绝
                    </Button>
                  </>
                )}
                {['pending', 'approved'].includes(a.state) && (
                  <Button
                    variant="outline"
                    disabled={!!pending}
                    onClick={() => void decision('revoke')}
                  >
                    {active?.request.dispatch_claimed_at ? '申请取消本次执行' : '撤销'}
                  </Button>
                )}
              </div>
            </>
          )}
          {active?.request.cancel_requested_at && (
            <p role="status">
              {active.request.dispatch_claimed_at
                ? '取消申请已记录；领取后不能承诺本次撤回，已发生的接收事实仍会保留。'
                : '已在发送权领取前撤销。'}
            </p>
          )}
          {active && ['unknown', 'claimed', 'dispatching'].includes(active.request.state) && (
            <div className="unknown-panel">
              <strong>结果尚未确定</strong>
              <p>
                没有查到记录不能证明未发送。核对读取独立模拟渠道账本；停止后续尝试也会保留未知结果。
              </p>
              {canApprove && (
                <div className="commerce-toolbar">
                  <Button disabled={!!pending} onClick={() => void reconcile('lookup')}>
                    核对渠道接收记录
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!!pending}
                    onClick={() => void reconcile('stop')}
                  >
                    停止后续尝试并核对
                  </Button>
                  {active.request.provider_capabilities?.idempotent &&
                    !active.request.cancel_requested_at && (
                      <Button
                        variant="outline"
                        disabled={!!pending}
                        onClick={() => void reconcile('safe_retry')}
                      >
                        按提供方幂等保证核对并恢复
                      </Button>
                    )}
                </div>
              )}
            </div>
          )}
          {threadId &&
            active &&
            ['quote', 'human_reply'].includes(active.request.intent) &&
            !active.request.dispatch_claimed_at && (
              <Button
                variant="outline"
                disabled={!!pending}
                onClick={() =>
                  void prepare(active.request.intent === 'quote' ? 'quote' : 'human_reply', active)
                }
              >
                以当前内容建立新版本并重新审批
              </Button>
            )}
          {threadId && view.request.intent === 'human_reply' && (
            <p className="team-caption">
              修改正文时，在上方“最终自由文本”输入新内容，再建立新版本。
            </p>
          )}
          <details>
            <summary>审批与执行历史</summary>
            {active?.events.map((e) => (
              <p key={e.id}>
                {commerceDate(e.created_at)} · {status[e.event_kind] ?? e.event_kind} · {e.reason}
              </p>
            ))}
            {active?.versions.map((v) => (
              <details key={v.id}>
                <summary>内容 v{v.version_no}</summary>
                <pre className="approval-body">{v.body_text}</pre>
              </details>
            ))}
            <details>
              <summary>审计详情（摘要、任务、attempt 与 token）</summary>
              <pre className="audit-json">
                {JSON.stringify(
                  {
                    request: active?.request,
                    payload: view.payload,
                    attempts: active?.attempts,
                    audit: active?.audit,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </details>
        </article>
      )}
    </section>
  );
}
