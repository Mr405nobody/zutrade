import { AIWorkspace } from './ai-workspace';
import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ChevronDown,
  FileText,
  Info,
  LockKeyhole,
  MessageCircle,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  UserRound,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import type { FactoryView, IdentityView, MemberView } from '@zutrade/contracts';
import { Button } from '@zutrade/ui';
import { QuoteWorkspace } from './quote-workspace';
import { FollowupPanel } from './outreach';

interface Thread {
  channel_identity: string | null;
  id: string;
  subject: string;
  contact_name: string;
  buyer_name: string | null;
  preview: string | null;
  control_mode: 'human' | 'assisted';
  owner_member_id: string | null;
  owner_name: string | null;
  takeover_member_id: string | null;
  takeover_name: string | null;
  assigned: boolean;
  row_version: string;
  context_revision: string;
  unread_count: number;
  latest_ingest_seq: string | null;
  factories: { id: string; name: string }[];
  updated_at: string;
  last_activity_at: string;
}
interface Message {
  id: string;
  body: string;
  direction: string;
  ingest_seq: string;
  occurred_at: string;
  created_at: string;
  status: string | null;
}
interface Note {
  id: string;
  body: string;
  author_name: string;
  created_at: string;
}
interface Outbound {
  id: string;
  status: string;
  body: string;
  error: string | null;
  created_at: string;
}
interface Detail {
  thread: Thread;
  notes: Note[];
  drafts: { id: string; body: string; created_at: string }[];
  outbound_requests: Outbound[];
  authorized_members: { id: string; display_name: string }[];
}
interface Page<T> {
  items: T[];
  next_cursor: string | null;
}
interface Template {
  id: 'quantity' | 'use' | 'destination';
  label: string;
  body: string;
  version: number;
}
interface Receipt {
  id: string;
  state: string;
  normalized_thread_id?: string | null;
  last_error?: string | null;
  queue_state?: string | null;
}
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, '连接失败，请检查网络与 API 后重试。');
  }
  const data: unknown = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const detail =
      data && typeof data === 'object' && 'message' in data ? String(data.message) : '请求未完成';
    throw new ApiError(
      response.status,
      response.status === 409
        ? `版本或幂等冲突：${detail}。已重新读取最新状态，请核对后重试。`
        : response.status === 403
          ? '权限已失效或无权访问，相关会话已关闭。'
          : response.status === 401
            ? '登录已失效，请重新登录。'
            : detail,
    );
  }
  return data as T;
}
function time(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
}
function dateTime(value: string) {
  return new Date(value).toLocaleString([], {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
function statusLabel(status: string) {
  const labels: Record<string, string> = {
    simulated: '模拟执行完成',
    queued: '等待 worker',
    pending: '处理中',
    claimed: '已领取 · 模拟执行中',
    failed: '处理失败',
    blocked: '已阻止',
    cancelled: '已取消',
    unknown: '结果不明 · 待核对',
    accepted: '收据已保存 · 等待 worker',
    processed: '标准化完成',
    normalized: '标准化完成',
    received: '收据已保存 · 等待 worker',
    dead: '处理失败 · 屏障保留',
    superseded: '上下文已变化 · 已失效',
    invalidated: '上下文已变化 · 已失效',
  };
  return labels[status] ?? status;
}
function receiptLabel(receipt: Receipt) {
  if (!['processed', 'normalized'].includes(receipt.state)) {
    if (receipt.queue_state === 'failed') return '任务处理失败 · 入站屏障保留';
    if (receipt.queue_state === 'retry') return '处理失败 · 等待队列重试（屏障保留）';
    if (receipt.queue_state === 'active') return 'worker 正在标准化 · 入站屏障生效';
    if (receipt.queue_state === 'created' || receipt.state === 'pending')
      return '收据已保存 · 等待 worker';
  }
  return statusLabel(receipt.state);
}
const alexBody =
  'Hi, I’m Alex Morgan from Northstar Events. We need 500 cotton tote bags, 35 × 40 cm, with a one-colour logo on one side. Could you send a quote? We would need them to arrive in six weeks.';

export function Inbox({
  member,
  memberships,
  onWorkspaceChange,
  initialThreadId,
}: {
  member: MemberView;
  memberships: MemberView[];
  onWorkspaceChange: (id: string) => void;
  initialThreadId?: string | null;
}) {
  const cache = useQueryClient();
  const base = `/api/workspaces/${member.workspace_id}/inbox`;
  const key = ['inbox', member.id, member.workspace_id];
  const [selected, setSelected] = useState<string | null>(initialThreadId ?? null);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'disconnected'>(
    'connecting',
  );
  const [subscriptionGeneration, setSubscriptionGeneration] = useState(0);
  const [replyContext, setReplyContext] = useState<{ threadId: string; revision: string } | null>(
    null,
  );
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [details, setDetails] = useState(false);
  const [team, setTeam] = useState(false);
  const [injector, setInjector] = useState(false);
  const [factoryId, setFactoryId] = useState('');
  const [note, setNote] = useState('');
  const [draft, setDraft] = useState('');
  const [templateId, setTemplateId] = useState('quantity');
  const [injection, setInjection] = useState<Receipt | null>(null);
  const injectionBody = useRef<{
    eventId: string;
    providerMessageId: string;
    identity: string;
    displayName: string;
    body: string;
    occurredAt: string;
    factoryId: string | null;
  } | null>(null);
  const replyCommand = useRef<{ fingerprint: string; id: string } | null>(null);
  const readPosition = useRef('');
  function resetPrivate() {
    setSelected(null);
    setDetails(false);
    setTeam(false);
    setNote('');
    setDraft('');
    setInjection(null);
    setReplyContext(null);
    cache.removeQueries({ queryKey: ['inbox'] });
    cache.removeQueries({ queryKey: ['factories', member.id] });
    cache.removeQueries({ queryKey: ['ai', member.id] });
    cache.removeQueries({ queryKey: ['ai-context', member.id] });
    void cache.invalidateQueries({ queryKey: ['me'] });
  }
  const threads = useInfiniteQuery({
    queryKey: [...key, 'threads'],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      api<Page<Thread>>(
        `${base}/threads${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    retry: false,
    refetchInterval: 10000,
  });
  const detail = useQuery({
    queryKey: [...key, 'detail', selected],
    queryFn: () => api<Detail>(`${base}/threads/${selected}`),
    enabled: Boolean(selected),
    retry: false,
  });
  const messages = useInfiniteQuery({
    queryKey: [...key, 'messages', selected],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      api<Page<Message>>(
        `${base}/threads/${selected}/messages${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: Boolean(selected),
    retry: false,
  });
  const templates = useQuery({
    queryKey: [...key, 'templates'],
    queryFn: () => api<Template[]>(`${base}/templates`),
    retry: false,
  });
  const factories = useQuery({
    queryKey: ['factories', member.id],
    queryFn: () => api<FactoryView[]>(`/api/workspaces/${member.workspace_id}/factories`),
    enabled: member.role === 'owner',
    retry: false,
  });
  const receipts = useQuery({
    queryKey: [...key, 'receipts'],
    queryFn: () => api<Receipt[]>(`${base}/simulation`),
    enabled: member.role === 'owner' && injector,
    retry: false,
    refetchInterval: 2000,
  });
  const thread = detail.data?.thread;
  const allMessages = [...(messages.data?.pages ?? [])].reverse().flatMap((page) => page.items);
  const latestMessage = allMessages.at(-1);
  const selectedTemplate = templates.data?.find((t) => t.id === templateId);
  const replyContextChanged = Boolean(
    thread &&
    replyContext?.threadId === thread.id &&
    replyContext.revision !== thread.context_revision,
  );
  useEffect(() => {
    if (!thread) return;
    setReplyContext((current) =>
      current?.threadId === thread.id
        ? current
        : { threadId: thread.id, revision: thread.context_revision },
    );
  }, [thread?.id, thread?.context_revision]);
  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const stream = new EventSource(`${base}/events`, { withCredentials: true });
    const refresh = () => {
      if (!navigator.onLine) return;
      setConnection('connected');
      void cache.invalidateQueries({ queryKey: key });
    };
    const reconnectIfAuthorized = async () => {
      if (!navigator.onLine) return;
      await cache.refetchQueries({ queryKey: ['me'] });
      if (disposed) return;
      const identity = cache.getQueryData<IdentityView | null>(['me']);
      const valid =
        cache.getQueryState(['me'])?.status === 'success' &&
        identity?.memberships.some(
          (m) =>
            m.id === member.id && m.workspace_id === member.workspace_id && m.status === 'active',
        );
      if (valid) {
        setConnection('connecting');
        setSubscriptionGeneration((value) => value + 1);
      }
    };
    const scheduleReconnect = () => {
      stream.close();
      setConnection('disconnected');
      if (reconnectTimer === undefined)
        reconnectTimer = setTimeout(() => void reconnectIfAuthorized(), 1500);
    };
    stream.addEventListener('connected', refresh);
    stream.addEventListener('change', refresh);
    stream.addEventListener('permission-lost', () => {
      scheduleReconnect();
      setError('成员或工厂权限已变化，已关闭当前会话并清理缓存；正在重新检查可访问范围。');
      resetPrivate();
    });
    stream.addEventListener('unavailable', scheduleReconnect);
    stream.onopen = () => {
      if (disposed || !navigator.onLine) return;
      setConnection('connected');
      void cache.invalidateQueries({ queryKey: key });
    };
    stream.onerror = () => setConnection('disconnected');
    const offline = () => {
      stream.close();
      setConnection('disconnected');
    };
    const online = () => void reconnectIfAuthorized();
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    if (!navigator.onLine) offline();
    return () => {
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
      disposed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      stream.close();
    };
  }, [base, member.id, cache, subscriptionGeneration]);
  useEffect(() => {
    const issue = [threads.error, detail.error, messages.error].find(
      (e) => e instanceof ApiError && [401, 403, 404].includes(e.status),
    );
    if (issue) {
      setError(issue.message);
      resetPrivate();
    }
  }, [threads.error, detail.error, messages.error]);
  useEffect(() => {
    if (!selected || !latestMessage || !thread) return;
    const position = `${selected}:${latestMessage.id}`;
    if (readPosition.current === position) return;
    readPosition.current = position;
    void api(`${base}/threads/${selected}/read`, { messageId: latestMessage.id })
      .then(() => cache.invalidateQueries({ queryKey: [...key, 'threads'] }))
      .catch((err: unknown) => {
        readPosition.current = '';
        setError(err instanceof Error ? err.message : '已读位置保存失败');
      });
  }, [selected, latestMessage?.id, thread?.id]);
  async function command(name: string, path: string, body: unknown, success?: () => void) {
    setPending(name);
    setError('');
    try {
      await api(path, body);
      success?.();
      await cache.invalidateQueries({ queryKey: key });
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
      if (err instanceof ApiError && [401, 403, 404].includes(err.status)) resetPrivate();
      else await cache.invalidateQueries({ queryKey: key });
    } finally {
      setPending('');
    }
  }
  function openThread(id: string) {
    setSelected(id);
    setDetails(false);
    setTeam(false);
    setNote('');
    setDraft('');
    setReplyContext(null);
    setError('');
  }
  async function inject(retry = false) {
    if (!retry || !injectionBody.current)
      injectionBody.current = {
        eventId: `alex-${crypto.randomUUID()}`,
        providerMessageId: `sim-${crypto.randomUUID()}`,
        identity: 'alex.morgan@northstar-events.example',
        displayName: 'Alex Morgan',
        body: alexBody,
        occurredAt: new Date().toISOString(),
        factoryId: factoryId || null,
      };
    setPending('inject');
    setError('');
    try {
      setInjection(await api<Receipt>(`${base}/simulation`, injectionBody.current));
      await cache.invalidateQueries({ queryKey: key });
    } catch (err) {
      setError(err instanceof Error ? err.message : '模拟收据提交失败');
    } finally {
      setPending('');
    }
  }
  return (
    <div className={`inbox-layout ${selected ? 'has-selection' : ''}`}>
      <aside className="inbox-list">
        <div className="inbox-list-heading">
          <h1>消息</h1>
          <button
            className="icon-button"
            aria-label="刷新会话列表"
            onClick={() => void cache.invalidateQueries({ queryKey: key })}
          >
            <RefreshCw size={18} className={threads.isFetching ? 'animate-spin' : ''} />
          </button>
        </div>
        {memberships.length > 1 && (
          <select
            className="workspace-select"
            aria-label="消息工作区"
            value={member.workspace_id}
            onChange={(e) => onWorkspaceChange(e.target.value)}
          >
            {memberships.map((m) => (
              <option key={m.id} value={m.workspace_id}>
                {m.workspace_name}
              </option>
            ))}
          </select>
        )}
        <div className="inbox-subheading">
          <span>全部会话</span>
          <span className="simulation-tag">模拟渠道</span>
        </div>
        {member.role === 'owner' && (
          <button
            className="inject-toggle"
            onClick={() => setInjector(!injector)}
            aria-expanded={injector}
          >
            <Plus size={16} />
            注入模拟买家消息
            <ChevronDown size={14} />
          </button>
        )}
        {injector && (
          <section className="inject-panel" aria-label="模拟入站">
            <strong>Alex Morgan · Northstar Events</strong>
            <p>500 件棉布袋、单色 logo、询价及六周到货需求。需求尚未经工厂确认。</p>
            <label>
              归属工厂
              <select
                aria-label="归属工厂"
                value={factoryId}
                onChange={(e) => setFactoryId(e.target.value)}
              >
                <option value="">待分配 · 仅 owner 可见</option>
                {factories.data?.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <Button
              disabled={Boolean(pending) || factories.isPending}
              onClick={() => void inject()}
            >
              {pending === 'inject' ? '正在保存原始收据…' : '注入 Alex 询盘'}
            </Button>
            {injectionBody.current && (
              <button
                className="text-button"
                disabled={Boolean(pending)}
                onClick={() => void inject(true)}
              >
                重放同一事件（验证幂等）
              </button>
            )}
            {injection && (
              <p role="status">
                最近提交：{receiptLabel(injection)}
                <br />
                <small>{injection.id}</small>
              </p>
            )}
            {receipts.isError && <p role="alert">{receipts.error.message}</p>}
            {receipts.data?.slice(0, 3).map((r) => (
              <div className="receipt" key={r.id}>
                <span>{receiptLabel(r)}</span>
                {r.last_error && <small>{r.last_error}</small>}
                {r.normalized_thread_id && (
                  <button
                    className="text-button"
                    onClick={() => openThread(r.normalized_thread_id!)}
                  >
                    查看会话
                  </button>
                )}
              </div>
            ))}
          </section>
        )}
        <div className="thread-items">
          {threads.isPending ? (
            <div className="inbox-empty">正在从数据库读取会话…</div>
          ) : threads.isError ? (
            <div className="inbox-empty" role="alert">
              <p>{threads.error.message}</p>
              <Button variant="outline" onClick={() => void threads.refetch()}>
                重试
              </Button>
            </div>
          ) : !threads.data?.pages[0]?.items.length ? (
            <div className="inbox-empty">
              <MessageCircle size={34} strokeWidth={1.2} />
              <h2>还没有会话</h2>
              <p>
                {member.role === 'owner'
                  ? '注入模拟询盘后，worker 会将收据处理为真实保存的会话。'
                  : '当前没有可访问的会话。未分配工厂的会话由 owner 处理。'}
              </p>
            </div>
          ) : (
            threads.data.pages
              .flatMap((page) => page.items)
              .map((item) => (
                <button
                  className={`thread-item ${selected === item.id ? 'selected' : ''}`}
                  key={item.id}
                  data-thread-id={item.id}
                  onClick={() => openThread(item.id)}
                >
                  <span className="contact-avatar">
                    {(item.contact_name ?? '?')
                      .split(' ')
                      .map((n) => n[0])
                      .slice(0, 2)
                      .join('')}
                  </span>
                  <span className="thread-copy">
                    <span className="thread-line">
                      <strong>{item.contact_name}</strong>
                      <time>{time(item.last_activity_at)}</time>
                    </span>
                    <span className="thread-line">
                      <span>{item.buyer_name || item.subject}</span>
                      {Number(item.unread_count) > 0 && (
                        <span className="unread-badge" aria-label={`${item.unread_count} 条未读`}>
                          {item.unread_count}
                        </span>
                      )}
                    </span>
                    <span className="thread-preview">{item.preview ?? '暂无消息'}</span>
                    <span className="thread-factories">
                      {!item.assigned
                        ? '待分配工厂 · 仅 owner'
                        : item.control_mode === 'human'
                          ? `${item.takeover_name ?? '成员'}已接管`
                          : '人工协作 · 模拟 AI 可用'}
                    </span>
                  </span>
                </button>
              ))
          )}
          {threads.hasNextPage && (
            <button
              className="load-more"
              disabled={threads.isFetchingNextPage}
              onClick={() => void threads.fetchNextPage()}
            >
              {threads.isFetchingNextPage ? '正在加载…' : '加载更多会话'}
            </button>
          )}
        </div>
        <div className={`realtime-status ${connection}`} role="status">
          {connection === 'connected' ? <Wifi size={13} /> : <WifiOff size={13} />}
          <span>
            {connection === 'connected'
              ? '实时通知已连接'
              : connection === 'connecting'
                ? '正在连接实时通知…'
                : '实时连接已断开 · 正在重连'}
          </span>
        </div>
      </aside>
      <main className="chat-panel">
        {connection === 'disconnected' && (
          <div className="realtime-banner" role="status">
            <WifiOff size={14} />
            实时连接已断开，正在重连；恢复后将重新查询数据库。
          </div>
        )}
        {error && (
          <div className="inbox-alert" role="alert">
            <span>{error}</span>
            <button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {!selected ? (
          <div className="chat-welcome">
            <span className="welcome-icon">
              <MessageCircle size={40} strokeWidth={1.3} />
            </span>
            <h2>从一条消息开始</h2>
            <p>选择会话，查看买家需求并与团队协作。</p>
            <span>
              <ShieldCheck size={14} />
              所有买家消息与发送均为模拟
            </span>
          </div>
        ) : detail.isPending ? (
          <div className="inbox-empty">正在验证权限并加载会话…</div>
        ) : detail.isError ? (
          <div className="inbox-empty">
            <p role="alert">{detail.error.message}</p>
            <Button onClick={() => void detail.refetch()}>重试</Button>
          </div>
        ) : (
          thread && (
            <>
              <header className="chat-heading">
                <button
                  className="icon-button mobile-back"
                  aria-label="返回会话列表"
                  onClick={() => setSelected(null)}
                >
                  <ArrowLeft size={21} />
                </button>
                <div className="chat-title">
                  <h2>{thread.contact_name}</h2>
                  <p>
                    {thread.buyer_name || thread.subject}
                    <span>·</span>模拟消息
                  </p>
                </div>
                <div className="chat-actions">
                  <button
                    className={`secondary-action ${details ? 'selected' : ''}`}
                    onClick={() => setDetails(!details)}
                    aria-expanded={details}
                  >
                    <Info size={17} />
                    <span>资料</span>
                  </button>
                  <button
                    className="secondary-action"
                    disabled={Boolean(pending)}
                    onClick={() =>
                      void command(
                        'takeover',
                        `${base}/threads/${selected}/${thread.control_mode === 'human' ? 'release' : 'takeover'}`,
                        { expectedVersion: thread.row_version },
                      )
                    }
                  >
                    <UserRound size={17} />
                    <span>
                      {pending === 'takeover'
                        ? '确认中…'
                        : thread.control_mode === 'human'
                          ? '释放接管'
                          : '人工接管'}
                    </span>
                  </button>
                </div>
              </header>
              <div className="thread-context">
                <span className="simulation-tag">模拟</span>
                <span>
                  {thread.control_mode === 'human'
                    ? `${thread.takeover_name ?? '成员'}已人工接管`
                    : '人工协作 · 模拟 AI 可用'}
                </span>
                <span className="context-owner">负责人：{thread.owner_name ?? '未认领'}</span>
                {!thread.owner_member_id && (
                  <button
                    className="text-button"
                    disabled={Boolean(pending)}
                    onClick={() =>
                      void command('claim', `${base}/threads/${selected}/claim`, {
                        expectedVersion: thread.row_version,
                      })
                    }
                  >
                    认领
                  </button>
                )}
              </div>
              {details && (
                <section className="thread-details" aria-label="会话资料">
                  <div>
                    <strong>会话资料</strong>
                    <button
                      className="icon-button"
                      aria-label="关闭资料"
                      onClick={() => setDetails(false)}
                    >
                      <X size={16} />
                    </button>
                  </div>
                  <p>
                    工厂：
                    {thread.factories.map((f) => f.name).join('、') || '待分配 · 仅 owner 可见'}
                  </p>
                  <p>
                    买家的数量与到货期仅为需求，价格与供给条件请在内部工作区根据已确认资料核对。
                  </p>
                  {member.role === 'owner' && !thread.assigned && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const value = new FormData(e.currentTarget).get('factory');
                        void command('assign', `${base}/threads/${selected}/assign`, {
                          expectedVersion: thread.row_version,
                          factoryId: value,
                        });
                      }}
                    >
                      <label>
                        分配归属工厂
                        <select name="factory" required defaultValue="">
                          <option value="" disabled>
                            请选择工厂
                          </option>
                          {factories.data?.map((f) => (
                            <option value={f.id} key={f.id}>
                              {f.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <Button disabled={Boolean(pending)}>确认分配</Button>
                    </form>
                  )}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const value = new FormData(e.currentTarget).get('owner');
                      void command('owner', `${base}/threads/${selected}/owner`, {
                        expectedVersion: thread.row_version,
                        memberId: value || null,
                      });
                    }}
                  >
                    <label>
                      负责人
                      <select
                        name="owner"
                        key={`owner-select:${thread.owner_member_id ?? 'unassigned'}`}
                        defaultValue={thread.owner_member_id ?? ''}
                      >
                        <option value="">未分配</option>
                        {detail.data.authorized_members.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.display_name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Button variant="outline" disabled={Boolean(pending)}>
                      保存负责人
                    </Button>
                  </form>
                  <small>
                    会话版本 {thread.row_version} · 上下文版本 {thread.context_revision}
                  </small>
                </section>
              )}
              <div className="chat-scroll">
                <div className="chat-date">买家会话 · 模拟记录</div>
                {messages.hasNextPage && (
                  <button
                    className="load-more"
                    disabled={messages.isFetchingNextPage}
                    onClick={() => void messages.fetchNextPage()}
                  >
                    {messages.isFetchingNextPage ? '正在加载历史…' : '加载更早消息'}
                  </button>
                )}
                {messages.isPending ? (
                  <p className="inbox-empty">正在读取消息…</p>
                ) : messages.isError ? (
                  <div className="inbox-alert" role="alert">
                    {messages.error.message}
                    <button onClick={() => void messages.refetch()}>重试</button>
                  </div>
                ) : allMessages.length === 0 ? (
                  <p className="inbox-empty">尚无标准化消息。原始收据可能仍在等待 worker。</p>
                ) : (
                  allMessages.map((message) => (
                    <article
                      key={message.id}
                      data-message-id={message.id}
                      className={`message-row ${message.direction === 'outbound' ? 'outbound' : 'inbound'}`}
                    >
                      <span className="message-avatar">
                        {message.direction === 'outbound'
                          ? 'Z'
                          : (thread.contact_name ?? '?').slice(0, 1)}
                      </span>
                      <div className="message-content">
                        <div className="message-bubble">{message.body}</div>
                        <div className="message-meta">
                          <time>{dateTime(message.occurred_at || message.created_at)}</time>
                          {message.direction === 'outbound' && (
                            <span>{message.status ? statusLabel(message.status) : '模拟消息'}</span>
                          )}
                        </div>
                      </div>
                    </article>
                  ))
                )}
                {Boolean(detail.data.outbound_requests.length) && (
                  <section className="delivery-status" aria-label="模拟发送状态">
                    {detail.data.outbound_requests.map((request) => (
                      <div
                        key={request.id}
                        data-request-id={request.id}
                        className={`delivery-row state-${request.status}`}
                      >
                        <span>{statusLabel(request.status)}</span>
                        <small>{dateTime(request.created_at)}</small>
                        {request.error && <p>{request.error}</p>}
                      </div>
                    ))}
                  </section>
                )}
                <section className="team-area">
                  <button
                    className="team-toggle"
                    onClick={() => setTeam(!team)}
                    aria-expanded={team}
                  >
                    <LockKeyhole size={15} />
                    <strong>内部工作区 · 仅团队可见</strong>
                    <span>{detail.data.notes.length} 条备注</span>
                    <ChevronDown size={16} />
                  </button>
                  {team && (
                    <div className="team-content">
                      <AIWorkspace
                        key={'ai-' + thread.id}
                        member={member}
                        threadId={thread.id}
                        identity={thread.channel_identity ?? ''}
                      />
                      <QuoteWorkspace
                        key={thread.id}
                        member={member}
                        threadId={thread.id}
                        contextRevision={thread.context_revision}
                      />
                      <p className="team-caption">备注与自由文本草稿不会进入买家消息或外发内容。</p>
                      <FollowupPanel member={member} threadId={thread.id} />
                      {detail.data.notes.length === 0 ? (
                        <p className="team-caption">暂无内部备注</p>
                      ) : (
                        detail.data.notes.map((n) => (
                          <article className="team-note" key={n.id}>
                            <div>
                              <strong>{n.author_name}</strong>
                              <time>{dateTime(n.created_at)}</time>
                            </div>
                            <p>{n.body}</p>
                          </article>
                        ))
                      )}
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void command(
                            'note',
                            `${base}/threads/${selected}/notes`,
                            { body: note, commandId: crypto.randomUUID() },
                            () => setNote(''),
                          );
                        }}
                      >
                        <label className="sr-only" htmlFor="team-note">
                          内部备注
                        </label>
                        <textarea
                          id="team-note"
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          placeholder="记录需求、分工或待确认事项…"
                          maxLength={4000}
                          required
                        />
                        <Button variant="outline" disabled={Boolean(pending) || !note.trim()}>
                          {pending === 'note' ? '正在保存…' : '添加内部备注'}
                        </Button>
                      </form>
                      <details className="draft-section">
                        <summary>
                          <FileText size={15} />
                          内部自由文本草稿（不能外发）
                        </summary>
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            void command(
                              'draft',
                              `${base}/threads/${selected}/drafts`,
                              { body: draft, commandId: crypto.randomUUID() },
                              () => setDraft(''),
                            );
                          }}
                        >
                          <label className="sr-only" htmlFor="internal-draft">
                            内部自由文本草稿
                          </label>
                          <textarea
                            id="internal-draft"
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            placeholder="未审核的内容仅在团队内部保存。需要外发时，请在审批区提交最终自由文本。"
                            maxLength={4000}
                            required
                          />
                          <Button variant="outline" disabled={Boolean(pending) || !draft.trim()}>
                            {pending === 'draft' ? '正在保存…' : '保存内部草稿'}
                          </Button>
                        </form>
                        {detail.data.drafts.map((d) => (
                          <article className="internal-draft" key={d.id}>
                            <small>内部草稿 · {dateTime(d.created_at)}</small>
                            <p>{d.body}</p>
                          </article>
                        ))}
                      </details>
                    </div>
                  )}
                </section>
              </div>
              <form
                className="reply-composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (
                    !selectedTemplate ||
                    !replyContext ||
                    replyContext.threadId !== thread.id ||
                    replyContextChanged
                  ) {
                    setError('会话上下文已变化，请核对最新消息并确认回复上下文后再发送。');
                    return;
                  }
                  const fingerprint = `${selected}:${templateId}:${replyContext.revision}`;
                  if (replyCommand.current?.fingerprint !== fingerprint)
                    replyCommand.current = { fingerprint, id: crypto.randomUUID() };
                  void command('reply', `${base}/threads/${selected}/reply`, {
                    commandId: replyCommand.current.id,
                    templateId,
                    contextRevision: replyContext.revision,
                  });
                }}
              >
                <div className="composer-heading">
                  <label htmlFor="reply-template">受控澄清回复</label>
                  <span>固定模板 · 不含商业承诺</span>
                </div>
                {templates.isError ? (
                  <p role="alert">模板读取失败：{templates.error.message}</p>
                ) : (
                  <>
                    <select
                      id="reply-template"
                      value={templateId}
                      onChange={(e) => {
                        setTemplateId(e.target.value);
                        setReplyContext({ threadId: thread.id, revision: thread.context_revision });
                      }}
                      disabled={templates.isPending}
                    >
                      {templates.isPending ? (
                        <option>正在读取服务端模板…</option>
                      ) : (
                        templates.data?.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.label}
                          </option>
                        ))
                      )}
                    </select>
                    <p className="template-preview">
                      {selectedTemplate?.body ?? '选择服务端维护的澄清模板'}
                    </p>
                  </>
                )}
                {replyContextChanged && (
                  <div className="reply-context-warning" role="status">
                    <p>收到新消息或接管状态已变化。请核对最新会话，再确认本条回复。</p>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        setReplyContext({ threadId: thread.id, revision: thread.context_revision })
                      }
                    >
                      已核对，使用最新上下文
                    </button>
                  </div>
                )}
                <div className="composer-footer">
                  <button type="button" className="text-button" onClick={() => setTeam(true)}>
                    <LockKeyhole size={13} />
                    添加内部备注 / 草稿
                  </button>
                  <Button
                    disabled={
                      Boolean(pending) || !selectedTemplate || !replyContext || replyContextChanged
                    }
                  >
                    <Send size={15} />
                    {pending === 'reply' ? '正在提交网关…' : '模拟发送'}
                  </Button>
                </div>
              </form>
            </>
          )
        )}
      </main>
    </div>
  );
}
