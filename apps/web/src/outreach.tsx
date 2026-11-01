import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@zutrade/ui';
import { resolveLocalTime } from '@zutrade/contracts';
import type {
  MemberView,
  D2Workspace,
  D2BatchView,
  BatchDraft,
  FollowupView,
} from '@zutrade/contracts';
import { commerceRequest, commerceDate, CommerceApiError } from './commerce-api';
const status: Record<string, string> = {
  awaiting_approval: '待 owner 审批',
  draft: '草稿',
  active: '执行中',
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
  revoked: '已撤销',
  invalidated: '已失效',
  expired: '已到期',
  queued: '已排队，尚未完成',
  ready: '到期待处理',
  scheduled: '已安排',
  executing: '执行中（结果不明时须核对）',
  claimed: '已领取发送权',
  dispatching: '正在模拟执行',
  simulated: '模拟完成',
  failed: '失败',
  blocked: '已阻挡',
  unknown: 'unknown · 须核对',
  cancelled: '已停止',
  completed: '已完成',
  paused: '已暂停',
};
const wallTime = (date: Date) =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const openThread = (id: string) =>
  window.dispatchEvent(new CustomEvent('zutrade-open-thread', { detail: id }));
export function OutreachPanel({ member, tasks = false }: { member: MemberView; tasks?: boolean }) {
  const base = `/api/workspaces/${member.workspace_id}/outreach`,
    cache = useQueryClient();
  const query = useQuery({
    queryKey: ['d2', member.id],
    queryFn: () => commerceRequest<D2Workspace>(base),
    refetchInterval: 3000,
    retry: false,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<{ id: string; version: string } | null>(null),
    [preview, setPreview] = useState<{ batch: D2BatchView; versionId: string } | null>(null);
  const [name, setName] = useState('首次模拟联系'),
    [zone, setZone] = useState('Asia/Shanghai'),
    [start, setStart] = useState(wallTime(new Date(Date.now() + 600000))),
    [deadline, setDeadline] = useState(wallTime(new Date(Date.now() + 3600000))),
    [interval, setIntervalValue] = useState(1000);
  const [items, setItems] = useState<BatchDraft['items']>([]);
  const previewRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (preview) previewRef.current?.scrollIntoView({ block: 'start' });
  }, [preview]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const blocked =
    query.error instanceof CommerceApiError && [401, 403, 404].includes(query.error.status);
  const data = blocked ? undefined : query.data;
  useEffect(() => {
    if (blocked) {
      setPreview(null);
      setItems([]);
      setEditing(null);
      setChoices({});
    }
  }, [blocked]);
  const canApprove = member.role === 'owner' && member.approver_member_id === member.id;
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      await cache.invalidateQueries({ queryKey: ['d2', member.id] });
      await cache.invalidateQueries({ queryKey: ['approvals', member.id] });
      setBusy(false);
    }
  }
  function edit(b: D2BatchView) {
    setEditing({ id: b.id, version: b.row_version });
    setName(b.draft.name);
    setZone(b.draft.timeZone);
    const wall = (s: string) => {
      const p = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
          timeZone: b.draft.timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        })
          .formatToParts(new Date(s))
          .map((p) => [p.type, p.value]),
      );
      return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
    };
    setStart(wall(b.draft.startAt));
    setDeadline(wall(b.draft.deadline));
    setIntervalValue(b.draft.intervalMs);
    setItems(b.draft.items);
  }
  async function save() {
    await act(async () => {
      const first = data?.leads.find((l) => l.id === items[0]?.leadId);
      if (!first) throw new Error('请先选取已确认并授权模拟身份的线索');
      if (
        items.some(
          (x) => data?.leads.find((l) => l.id === x.leadId)?.factory_id !== first.factory_id,
        )
      )
        throw new Error('一个批次只能代表一家工厂');
      const d: BatchDraft = {
        name,
        factoryId: first.factory_id,
        timeZone: zone,
        startAt: resolveLocalTime(start, zone),
        deadline: resolveLocalTime(deadline, zone),
        intervalMs: interval,
        items,
      };
      const r = await commerceRequest<{ id: string; row_version: string }>(`${base}/drafts`, {
        commandId: crypto.randomUUID(),
        batchId: editing?.id ?? null,
        expectedVersion: editing?.version ?? null,
        draft: d,
      });
      setEditing({ id: r.id, version: r.row_version });
      setNotice('草稿已保存；提交完整版本后才申请 owner 审批。');
    });
  }
  async function decide(decision: 'approve' | 'reject' | 'revoke') {
    if (!preview) return;
    const v = preview.batch.versions.find((v) => v.id === preview.versionId);
    if (!v?.approval) return;
    await act(async () => {
      await commerceRequest(`${base}/batches/${preview.batch.id}/decision`, {
        commandId: crypto.randomUUID(),
        versionId: v.id,
        snapshotSha256: v.snapshot_sha256,
        expectedVersion: v.approval!.row_version,
        decision,
        reason: '',
      });
      setNotice(
        decision === 'approve'
          ? '批次已排队，逐项状态以实际网关结果为准。'
          : '已保存审批决定；已领取项须核对。',
      );
      setPreview(null);
    });
  }
  const pv = preview?.batch.versions.find((v) => v.id === preview.versionId);
  if (blocked)
    return (
      <section className="commerce-panel">
        <p role="alert">访问权限或登录状态已变化，已关闭批次内容。请重新登录或选择有权工作区。</p>
      </section>
    );
  return (
    <section className="commerce-panel d2-panel" aria-label={tasks ? '批次与跟进待办' : '触达批次'}>
      <h2>{tasks ? '批次与跟进待办' : '线索与触达批次'}</h2>
      <p className="team-caption">
        消息仅 simulation · AI mock。研究线索不自动获得真实渠道联系资格。
      </p>
      {query.isPending && <p>正在读取…</p>}
      {query.isError && <p role="alert">{query.error.message}</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!tasks && (
        <>
          <h3>已确认研究线索</h3>
          {!data?.leads.length && (
            <p>暂无已导入线索。请先在真实研究中核对来源并确认导入；联网受阻时这里保持为空。</p>
          )}
          {data?.leads.map((l) => (
            <article className="d2-card" key={l.id} data-lead-id={l.id}>
              <strong>{l.name}</strong>
              <p>
                {l.origin === 'offline_fixture' ? '离线测试数据 · 虚构公司' : '真实研究来源'} ·
                公司身份{l.identityConfirmed ? '已人工核对' : '待核对'}；个人身份未核实
              </p>
              <details>
                <summary>来源与联系方式资格</summary>
                <pre className="audit-json">
                  {JSON.stringify({ source: l.source, points: l.points }, null, 2)}
                </pre>
              </details>
              {!l.threadId ? (
                canApprove ? (
                  <div className="commerce-toolbar">
                    {data.accounts.map((a) => (
                      <Button
                        key={a.id}
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await commerceRequest(`${base}/contacts`, {
                              commandId: crypto.randomUUID(),
                              leadId: l.id,
                              accountId: a.id,
                              simulationAuthorized: true,
                            });
                            setNotice('已建立独立内部演示身份；真实 email/WhatsApp 权限保持原状。');
                          })
                        }
                      >
                        授权内部模拟身份 · {a.display_name}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <p>请指定 owner 授予内部模拟资格。</p>
                )
              ) : (
                <div className="commerce-toolbar">
                  <label>
                    模拟账号
                    <select
                      aria-label={'模拟账号 · ' + l.name}
                      value={choices[l.id] ?? l.threadId ?? ''}
                      onChange={(e) => {
                        setChoices({ ...choices, [l.id]: e.target.value });
                        setItems(
                          items.map((x) =>
                            x.leadId === l.id ? { ...x, threadId: e.target.value } : x,
                          ),
                        );
                      }}
                    >
                      {l.channels.map((ch) => (
                        <option key={ch.threadId} value={ch.threadId}>
                          {data.accounts.find((a) => a.id === ch.accountId)?.display_name ??
                            ch.accountId}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={items.some((x) => x.leadId === l.id)}
                      onChange={(e) =>
                        setItems(
                          e.target.checked
                            ? [
                                ...items,
                                {
                                  threadId: choices[l.id] ?? l.threadId!,
                                  leadId: l.id,
                                  quoteVersionId: null,
                                  subject: 'Product information introduction',
                                  body: `Hello ${l.name} team,\n\nWe represent ${l.factoryName}. May we share product information if relevant to your work?\n\nInternal simulation. No prior purchase interest is assumed.`,
                                },
                              ]
                            : items.filter((x) => x.leadId !== l.id),
                        )
                      }
                    />
                    加入逐人名单
                  </label>
                  <Button
                    variant="outline"
                    disabled={
                      busy ||
                      (!canApprove &&
                        !l.channels.find((ch) => ch.threadId === (choices[l.id] ?? l.threadId))
                          ?.permitted)
                    }
                    onClick={() =>
                      void act(async () => {
                        const p = l.channels.find(
                          (ch) => ch.threadId === (choices[l.id] ?? l.threadId),
                        );
                        if (p)
                          await commerceRequest(`${base}/points/${p.pointId}/permission`, {
                            allowed: !p.permitted,
                          });
                        setNotice(
                          p?.permitted
                            ? '已停止该模拟身份联系；真实渠道权限未改变。'
                            : '已重新授权此内部模拟身份；旧计划仍失效，真实渠道权限未改变。',
                        );
                      })
                    }
                  >
                    {l.channels.find((ch) => ch.threadId === (choices[l.id] ?? l.threadId))
                      ?.permitted
                      ? '停止模拟联系'
                      : '重新授权内部模拟'}
                  </Button>
                  {canApprove && (
                    <details>
                      <summary>授权其他模拟账号</summary>
                      {data.accounts
                        .filter((a) => !l.channels.some((ch) => ch.accountId === a.id))
                        .map((a) => (
                          <Button
                            key={a.id}
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              void act(async () => {
                                const result = await commerceRequest<{ threadId: string }>(
                                  `${base}/contacts`,
                                  {
                                    commandId: crypto.randomUUID(),
                                    leadId: l.id,
                                    accountId: a.id,
                                    simulationAuthorized: true,
                                  },
                                );
                                setChoices({ ...choices, [l.id]: result.threadId });
                                setNotice(
                                  '已建立独立内部模拟身份；请重新查看名单及正文，提交新版本审批。',
                                );
                              })
                            }
                          >
                            {a.display_name}
                          </Button>
                        ))}
                    </details>
                  )}
                </div>
              )}
            </article>
          ))}
          <details className="d2-editor" open={items.length > 0}>
            <summary>批次草稿 · 桌面支持完整编辑</summary>
            <div className="d2-fields">
              <label>
                批次名称
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label>
                IANA 时区
                <input value={zone} onChange={(e) => setZone(e.target.value)} />
              </label>
              <label>
                计划开始
                <input
                  type="datetime-local"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                />
              </label>
              <label>
                截止时间
                <input
                  type="datetime-local"
                  value={deadline}
                  onChange={(e) => setDeadline(e.target.value)}
                />
              </label>
              <label>
                逐项间隔（毫秒，至少1000）
                <input
                  type="number"
                  min={1000}
                  value={interval}
                  onChange={(e) => setIntervalValue(Number(e.target.value))}
                />
              </label>
            </div>
            {items.map((item, index) => (
              <fieldset key={item.leadId}>
                <legend>
                  第 {index + 1} 项 · {data?.leads.find((l) => l.id === item.leadId)?.name}
                </legend>
                <label>
                  最终主题
                  <input
                    value={item.subject}
                    onChange={(e) =>
                      setItems(
                        items.map((x, n) => (n === index ? { ...x, subject: e.target.value } : x)),
                      )
                    }
                  />
                </label>
                <label>
                  最终正文
                  <textarea
                    rows={6}
                    value={item.body}
                    onChange={(e) =>
                      setItems(
                        items.map((x, n) => (n === index ? { ...x, body: e.target.value } : x)),
                      )
                    }
                  />
                </label>
                <label>
                  引用报价版本（可选）
                  <input
                    value={item.quoteVersionId ?? ''}
                    onChange={(e) =>
                      setItems(
                        items.map((x, n) =>
                          n === index ? { ...x, quoteVersionId: e.target.value || null } : x,
                        ),
                      )
                    }
                  />
                </label>
                <small>引用报价时，最终正文及附件由已校验报价生成，提交后的逐人预览为准。</small>
              </fieldset>
            ))}
            <Button disabled={busy || !items.length} onClick={() => void save()}>
              保存批次草稿
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setEditing(null);
                setItems([]);
              }}
            >
              新建草稿
            </Button>
          </details>
        </>
      )}
      <h3>批次与不可变版本</h3>
      {!data?.batches.length && <p>暂无批次。</p>}
      {data?.batches.map((b) => (
        <article className="d2-card" key={b.id}>
          <strong>
            {b.name} · {status[b.state] ?? b.state}
          </strong>
          <p>
            实际逐项汇总：
            {Object.entries(b.summary)
              .map(([s, n]) => `${status[s] ?? s} ${n}`)
              .join('；') || '尚未提交'}
          </p>
          <div className="commerce-toolbar">
            {!tasks && (
              <>
                <Button variant="outline" onClick={() => edit(b)}>
                  编辑草稿／建立新版本
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await commerceRequest(`${base}/batches/${b.id}/freeze`, {
                        commandId: crypto.randomUUID(),
                        expectedVersion: b.row_version,
                      });
                      setEditing(null);
                      setNotice('新版本已冻结并申请审批，不继承旧批准。');
                    })
                  }
                >
                  提交完整版本审批
                </Button>
              </>
            )}
            {b.versions.map((v) => (
              <Button
                key={v.id}
                variant="outline"
                onClick={() => setPreview({ batch: b, versionId: v.id })}
              >
                预览 v{v.version_no} · {status[v.approval?.state ?? ''] ?? '未审批'}
              </Button>
            ))}
          </div>
        </article>
      ))}
      {pv && preview && (
        <article ref={previewRef} className="approval-preview" aria-label="批次逐人最终预览">
          <h3>
            {preview.batch.name} · v{pv.version_no}
          </h3>
          <p>
            代表工厂：
            {data?.leads.find((l) => l.factory_id === preview.batch.factory_id)?.factoryName ??
              preview.batch.factory_id}{' '}
            · {pv.items.length} 项 · 时区 {pv.send_rules.timeZone} · 间隔 {pv.send_rules.intervalMs}
            ms · 截止 {commerceDate(pv.valid_until)}
          </p>
          <p>
            停止条件：新回复、接管前旧上下文、退订、暂停、权限/事实/报价/需求失效。批准仅覆盖以下实际名单与完整内容。
          </p>
          {pv.items.map((x, n) => (
            <article className="d2-card" key={x.id}>
              <h4>
                第 {n + 1} 项 ·{' '}
                {data?.leads.find((l) => l.id === pv.send_rules.items[n]?.leadId)?.name ??
                  x.recipients_snapshot[0]?.identity}
              </h4>
              <p>
                模拟收件身份：{x.recipients_snapshot[0]?.identity} · 模拟账号：
                {x.sender_snapshot.displayName} · {commerceDate(x.scheduled_at)} ·{' '}
                {status[x.state] ?? x.state}
              </p>
              <strong>{x.subject}</strong>
              <pre className="approval-body">{x.body_text}</pre>
              <p>
                引用报价：{x.quote_version_id ?? '无'}；附件：
                {x.attachment_manifest.map((f) => f.filename).join('，') || '无'}
              </p>
              {x.attachment_manifest.length > 0 && (
                <a
                  href={`/api/workspaces/${member.workspace_id}/dispatch/requests/${x.outbound_request_id}/payloads/${x.payload_version_id}/pdf`}
                  target="_blank"
                  rel="noreferrer"
                >
                  打开已冻结 PDF
                </a>
              )}
              <p role="status">
                {x.stop_reason}
                {x.cancel_requested_at &&
                  (x.dispatch_claimed_at
                    ? ' · 取消申请已记录，不能承诺本次撤回'
                    : ' · 已在领取前取消')}
              </p>
              <details>
                <summary>请求与冻结摘要</summary>
                <p>{x.outbound_request_id}</p>
                <p>{x.payload_sha256}</p>
              </details>
            </article>
          ))}
          {canApprove && pv.approval && (
            <div className="commerce-toolbar">
              {pv.approval.state === 'pending' && (
                <>
                  <Button disabled={busy} onClick={() => void decide('approve')}>
                    批准完整批次并模拟执行
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => void decide('reject')}>
                    拒绝批次
                  </Button>
                </>
              )}
              {['pending', 'approved'].includes(pv.approval.state) && (
                <Button variant="outline" disabled={busy} onClick={() => void decide('revoke')}>
                  撤销／申请取消批次
                </Button>
              )}
            </div>
          )}
          <Button variant="outline" onClick={() => setPreview(null)}>
            关闭批次预览
          </Button>
        </article>
      )}
      {tasks && (
        <>
          <h3>待核对联系方式</h3>
          {data?.leads
            .filter((l) => !l.threadId)
            .map((l) => (
              <article className="d2-card" key={l.id}>
                <strong>{l.name}</strong>
                <p>
                  只有公司资料，未核实个人身份、真实联系资格或内部模拟授权。请在“找客户”核对证据。
                </p>
              </article>
            ))}
          <h3>到期跟进与停止历史</h3>
          <FollowupList
            member={member}
            entries={data?.followups ?? []}
            onChange={() => query.refetch()}
            names={Object.fromEntries((data?.members ?? []).map((m) => [m.id, m.display_name]))}
          />
          <h3>失败与核对</h3>
          {data?.tasks.map((t) => (
            <article className="d2-card" key={t.id}>
              <strong>{t.kind}</strong>
              <p>{t.reason}</p>
              <small>
                对象 {t.id}
                {t.threadId ? ` · 会话 ${t.threadId}` : ''}
              </small>
              <p>
                发送核对可在本页“最终外发审批与执行”中打开对应请求；原始入站失败继续形成发送屏障。
              </p>
              {t.threadId && (
                <Button variant="outline" onClick={() => openThread(t.threadId!)}>
                  打开会话与请求
                </Button>
              )}
              {t.kind === '原始入站失败' && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await commerceRequest(`${base}/receipts/${t.id}/retry`, {
                        commandId: crypto.randomUUID(),
                      });
                      setNotice('已申请重新处理原始收据；成功标准化前仍保留屏障。');
                    })
                  }
                >
                  重新处理原始收据
                </Button>
              )}
            </article>
          ))}
        </>
      )}
    </section>
  );
}
function FollowupList({
  member,
  entries,
  onChange,
  onEdit,
  names = {},
}: {
  member: MemberView;
  entries: FollowupView[];
  onChange: () => unknown;
  onEdit?: (f: FollowupView) => void;
  names?: Record<string, string>;
}) {
  const [error, setError] = useState('');
  return (
    <>
      {error && <p role="alert">{error}</p>}
      {!entries.length && <p>暂无跟进。</p>}
      {entries.map((f) => (
        <article className="d2-card" key={f.id}>
          <strong>
            {f.purpose} · v{f.business_version}
          </strong>
          <p>
            {status[f.state] ?? f.state} ·{' '}
            {f.execution_mode === 'manual' ? '提醒与内部草稿' : '需批准的自动模拟跟进'}
          </p>
          <p>
            {new Date(f.due_at).toLocaleString('zh-CN', { timeZone: f.time_zone })}（{f.time_zone}）
            · UTC {f.due_at}
          </p>
          <p>
            负责人 {names[f.owner_member_id] ?? f.owner_member_id} · 报价{' '}
            {f.quote_version_id ?? '无'}
          </p>
          <p role="status">{f.stop_reason}</p>
          <details>
            <summary>内部草稿与计划历史</summary>
            <pre className="approval-body">{f.internal_draft}</pre>
            <pre className="audit-json">{JSON.stringify(f.history, null, 2)}</pre>
          </details>
          <div className="commerce-toolbar">
            <Button variant="outline" onClick={() => openThread(f.thread_id)}>
              打开关联会话
            </Button>
            {f.execution_mode === 'manual' && f.state === 'ready' && (
              <Button
                variant="outline"
                onClick={() =>
                  void commerceRequest(
                    `/api/workspaces/${member.workspace_id}/outreach/followups/${f.id}/complete`,
                    { expectedVersion: f.row_version },
                  )
                    .then(() => onChange())
                    .catch((e) => setError(e.message))
                }
              >
                标记人工提醒已处理
              </Button>
            )}
            {onEdit && (
              <Button variant="outline" onClick={() => onEdit(f)}>
                改期／修改并重新审批
              </Button>
            )}
            {['scheduled', 'ready', 'executing'].includes(f.state) && (
              <Button
                variant="outline"
                onClick={() =>
                  void commerceRequest(
                    `/api/workspaces/${member.workspace_id}/outreach/followups/${f.id}/cancel`,
                    { expectedVersion: f.row_version },
                  )
                    .then(() => onChange())
                    .catch((e) => setError(String(e.message)))
                }
              >
                停止跟进
              </Button>
            )}
          </div>
        </article>
      ))}
    </>
  );
}
export function FollowupPanel({ member, threadId }: { member: MemberView; threadId: string }) {
  const base = `/api/workspaces/${member.workspace_id}`,
    cache = useQueryClient();
  const query = useQuery({
    queryKey: ['d2-followups', member.id, threadId],
    queryFn: () => commerceRequest<D2Workspace>(`${base}/outreach?threadId=${threadId}`),
    refetchInterval: 3000,
    retry: false,
  });
  const oq = useQuery({
    queryKey: ['d2-opportunities', member.id, threadId],
    queryFn: () =>
      commerceRequest<{
        opportunities: {
          id: string;
          title: string;
          quote: { current_version_id: string | null } | null;
        }[];
      }>(`${base}/quoting/threads/${threadId}`),
    retry: false,
  });
  const tq = useQuery({
    queryKey: ['d2-thread', member.id, threadId],
    queryFn: () =>
      commerceRequest<{ thread: { row_version: string; outbound_paused: boolean } }>(
        `${base}/inbox/threads/${threadId}`,
      ),
    refetchInterval: 3000,
  });
  const [editing, setEditing] = useState<FollowupView | null>(null),
    [purpose, setPurpose] = useState('核对下一步安排'),
    [draft, setDraft] = useState(''),
    [body, setBody] = useState('May we provide any further information?'),
    [at, setAt] = useState(wallTime(new Date(Date.now() + 600000))),
    [zone, setZone] = useState('Asia/Shanghai'),
    [mode, setMode] = useState('manual'),
    [op, setOp] = useState(''),
    [quote, setQuote] = useState(''),
    [owner, setOwner] = useState(member.id),
    [choice, setChoice] = useState<'reject' | 'earlier' | 'later'>('reject'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  useEffect(() => {
    if (!op && oq.data?.opportunities[0]) setOp(oq.data.opportunities[0].id);
  }, [op, oq.data]);
  async function refresh() {
    await cache.invalidateQueries({ queryKey: ['d2-followups', member.id, threadId] });
    await cache.invalidateQueries({ queryKey: ['d2-thread', member.id, threadId] });
    await cache.invalidateQueries({ queryKey: ['approvals', member.id] });
  }
  async function save() {
    setBusy(true);
    setError('');
    try {
      await commerceRequest(`${base}/outreach/followups`, {
        commandId: crypto.randomUUID(),
        followupId: editing?.id ?? null,
        expectedVersion: editing?.row_version ?? null,
        threadId,
        opportunityId: op,
        ownerMemberId: owner,
        quoteVersionId: quote || null,
        purpose,
        internalDraft: draft,
        mode,
        localTime: at,
        timeZone: zone,
        disambiguation: choice,
        subject: 'Follow-up',
        body,
      });
      setEditing(null);
      setNotice(
        mode === 'manual'
          ? '跟进提醒已保存。'
          : '最终内容已提交审批；请在外发审批区核对并由指定 owner 批准。',
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }
  function edit(f: FollowupView) {
    setEditing(f);
    setPurpose(f.purpose);
    setDraft(f.internal_draft);
    setBody(f.plan_snapshot.body);
    setAt(f.plan_snapshot.localTime);
    setZone(f.time_zone);
    setMode(f.execution_mode);
    setOp(f.opportunity_id);
    setQuote(f.quote_version_id ?? '');
    setOwner(f.owner_member_id);
    setChoice(f.plan_snapshot.disambiguation);
  }
  const blocked = [query.error, oq.error, tq.error].some(
    (e) => e instanceof CommerceApiError && [401, 403, 404].includes(e.status),
  );
  if (blocked)
    return (
      <section className="commerce-panel">
        <p role="alert">会话访问权限或登录状态已变化，已关闭跟进内容。</p>
      </section>
    );
  return (
    <section className="commerce-panel" aria-label="跟进计划">
      <h3>跟进计划</h3>
      {error && <p role="alert">{error}</p>}
      {query.isError && <p role="alert">{query.error.message}</p>}
      {notice && <p role="status">{notice}</p>}
      <Button
        variant="outline"
        onClick={() => {
          const t = tq.data?.thread;
          if (t)
            void commerceRequest(`${base}/outreach/threads/${threadId}/pause`, {
              expectedVersion: t.row_version,
              paused: !t.outbound_paused,
            })
              .then(refresh)
              .catch((e) => setError(e.message));
        }}
      >
        {tq.data?.thread.outbound_paused ? '恢复新外发' : '暂停全部新外发'}
      </Button>
      <details>
        <summary>
          {editing ? `修改计划 v${editing.business_version}` : '新增跟进（默认只提醒）'}
        </summary>
        <div className="d2-fields">
          <label>
            目标
            <input value={purpose} onChange={(e) => setPurpose(e.target.value)} />
          </label>
          <label>
            商机
            <select value={op} onChange={(e) => setOp(e.target.value)}>
              {oq.data?.opportunities.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            负责人
            <select value={owner} onChange={(e) => setOwner(e.target.value)}>
              {query.data?.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            本地到期时间
            <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
          </label>
          <label>
            IANA 时区
            <input value={zone} onChange={(e) => setZone(e.target.value)} />
          </label>
          <label>
            夏令时重叠处理
            <select value={choice} onChange={(e) => setChoice(e.target.value as typeof choice)}>
              <option value="reject">歧义时拒绝，要求明确选择</option>
              <option value="earlier">较早时刻</option>
              <option value="later">较晚时刻</option>
            </select>
          </label>
          <label>
            执行模式
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="manual">提醒与内部草稿</option>
              <option value="approved_automatic">批准最终内容后自动模拟跟进</option>
            </select>
          </label>
          <label>
            引用报价版本
            <select value={quote} onChange={(e) => setQuote(e.target.value)}>
              <option value="">无</option>
              {oq.data?.opportunities
                .filter((o) => o.id === op && o.quote?.current_version_id)
                .map((o) => (
                  <option key={o.id} value={o.quote!.current_version_id!}>
                    当前报价 {o.quote!.current_version_id}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <label>
          内部草稿
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} />
        </label>
        {mode === 'approved_automatic' && (
          <label>
            最终外发正文
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} />
            <small>
              引用报价时，最终正文及 PDF
              由该冻结报价生成；提交后查看完整审批预览。内部草稿不会自动进入外发。
            </small>
          </label>
        )}
        <Button disabled={busy || !op} onClick={() => void save()}>
          保存计划版本
        </Button>
        {editing && (
          <Button variant="outline" onClick={() => setEditing(null)}>
            改为新计划
          </Button>
        )}
      </details>
      <FollowupList
        member={member}
        entries={query.data?.followups ?? []}
        onChange={refresh}
        onEdit={edit}
        names={Object.fromEntries((query.data?.members ?? []).map((m) => [m.id, m.display_name]))}
      />
    </section>
  );
}
