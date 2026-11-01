import { useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@zutrade/ui';
import { identityViewSchema } from '@zutrade/contracts';
import type { FactoryView, WorkspaceMemberView, MemberView } from '@zutrade/contracts';

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? path === '/api/auth/sign-in/email'
          ? '邮箱或密码不正确，请检查后重新登录'
          : '登录已失效，请重新登录'
        : typeof data === 'object' && data && 'message' in data
          ? String(data.message)
          : '请求未完成',
    );
  return data as T;
}
export function IdentityPanel() {
  const cache = useQueryClient();
  const [workspace, setWorkspace] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const response = await fetch('/api/me', { credentials: 'include' });
      if (response.status === 401) return null;
      if (!response.ok) throw new Error('身份读取失败，请检查账号状态或服务');
      return identityViewSchema.parse(await response.json());
    },
    retry: false,
    refetchInterval: 10000,
  });
  const memberships = me.data?.memberships ?? [];
  const selected = memberships.find((m) => m.workspace_id === workspace) ?? memberships[0];
  const ws = selected?.workspace_id;
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      await request('/api/auth/sign-in/email', 'POST', {
        email: form.get('email'),
        password: form.get('password'),
      });
      cache.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' });
      await cache.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setPending(false);
    }
  }
  async function logout() {
    setPending(true);
    setError('');
    try {
      await request('/api/auth/sign-out', 'POST', {});
      cache.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' });
      setWorkspace('');
      await cache.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(false);
    }
  }
  if (me.isPending)
    return (
      <section className="identity-section" aria-label="身份与工作区">
        正在验证会话…
      </section>
    );
  if (me.isError)
    return (
      <section className="identity-section">
        <p role="alert">{me.error.message}</p>
        <Button onClick={() => void me.refetch()}>重试身份检查</Button>
      </section>
    );
  if (!me.data)
    return (
      <section className="identity-section" aria-label="登录">
        <div className="eyebrow">IDENTITY / A1</div>
        <h2>登录你的工作区</h2>
        <p>使用受控初始化的本地账号。账号资料见本地私有文件。</p>
        <form className="login-form" onSubmit={(event) => void login(event)}>
          <label>
            邮箱
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            密码
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              minLength={16}
            />
          </label>
          <Button type="submit" disabled={pending}>
            {pending ? '正在登录…' : '登录'}
          </Button>
        </form>
        {error && <p role="alert">{error}</p>}
      </section>
    );
  return (
    <section className="identity-section" aria-label="身份与工作区">
      <div className="identity-heading">
        <div>
          <div className="eyebrow">IDENTITY / A1</div>
          <h2>{me.data.user.display_name}</h2>
          <p>
            真实会话 · {selected?.role ?? '暂无成员资格'}
            {selected && selected.approver_member_id === selected.id ? ' · 指定审批人' : ''}
          </p>
        </div>
        <Button variant="outline" onClick={() => void logout()} disabled={pending}>
          退出登录
        </Button>
      </div>
      <label>
        当前工作区
        <select
          aria-label="当前工作区"
          value={ws ?? ''}
          onChange={(e) => setWorkspace(e.target.value)}
        >
          {memberships.map((m) => (
            <option key={m.id} value={m.workspace_id}>
              {m.workspace_name}
            </option>
          ))}
        </select>
      </label>
      {!selected && <p>暂无有效工作区。请由 owner 通过受控初始化建立成员资格。</p>}
      {error && <p role="alert">{error}</p>}
      <form
        className="profile-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          setPending(true);
          setError('');
          void request('/api/me', 'PATCH', { displayName: form.get('displayName') })
            .then(() => cache.invalidateQueries({ queryKey: ['me'] }))
            .catch((err) => setError(String(err)))
            .finally(() => setPending(false));
        }}
      >
        <label>
          显示名称
          <input
            name="displayName"
            defaultValue={me.data.user.display_name}
            required
            maxLength={80}
          />
        </label>
        <Button variant="outline" disabled={pending}>
          保存名称
        </Button>
      </form>
      {selected && <Workspace key={selected.id} member={selected} />}
    </section>
  );
}
function Workspace({ member }: { member: MemberView }) {
  const base = `/api/workspaces/${member.workspace_id}`;
  const cache = useQueryClient();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const factories = useQuery({
    queryKey: ['factories', member.id],
    queryFn: () => request<FactoryView[]>(`${base}/factories`),
    retry: false,
  });
  const members = useQuery({
    queryKey: ['members', member.id],
    queryFn: () => request<WorkspaceMemberView[]>(`${base}/members`),
    enabled: member.role === 'owner',
    retry: false,
  });
  const tasks = useQuery({
    queryKey: ['tasks', member.id],
    queryFn: () =>
      request<
        { id: string; pg_boss_job_id: string; consumed: boolean; queue_state: string | null }[]
      >(`${base}/tasks`),
    refetchInterval: 2000,
    retry: false,
  });
  async function mutate(path: string, body: unknown, method = 'PATCH') {
    setPending(true);
    setError('');
    try {
      await request(path, method, body);
      await cache.invalidateQueries();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="workspace-access">
      <h3>授权工厂</h3>
      <p>只显示服务端确认可访问的工厂。虚构工厂用于权限验收。</p>
      {factories.isPending ? (
        <p>正在读取工厂…</p>
      ) : factories.isError ? (
        <p role="alert">{factories.error.message}</p>
      ) : !factories.data?.length ? (
        <p>尚未分配工厂权限。</p>
      ) : (
        <div className="factory-list">
          {factories.data.map((f) => (
            <form
              key={f.id}
              aria-label={f.factory_code}
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void mutate(`${base}/factories/${f.id}`, {
                  name: form.get('name'),
                  commandId: crypto.randomUUID(),
                });
              }}
            >
              <div>
                <strong>{f.factory_code}</strong>
                <small>{f.status}</small>
              </div>
              <label>
                工厂名称
                <input name="name" defaultValue={f.name} required maxLength={120} />
              </label>
              <Button variant="outline" disabled={pending}>
                保存并验证队列
              </Button>
            </form>
          ))}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="task-list">
        <h3>我的验证任务</h3>
        <p>保存工厂名称时，业务、事件和任务一起提交；独立 worker 完成后显示“已消费”。</p>
        {tasks.isError ? (
          <p role="alert">{tasks.error.message}</p>
        ) : tasks.data?.length ? (
          <ul>
            {tasks.data.map((task) => (
              <li key={task.id}>
                <code>{task.id.slice(0, 8)}</code>
                <span>
                  {task.consumed
                    ? '已消费'
                    : task.queue_state === 'failed'
                      ? '处理失败，请检查 worker 日志'
                      : task.queue_state === 'cancelled'
                        ? '已取消'
                        : '等待 worker'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p>暂无验证任务。</p>
        )}
      </div>
      {member.role === 'owner' && (
        <div className="member-management">
          <h3>成员与权限</h3>
          <p>新增登录账号使用受控本地初始化；这里管理已有成员。审批仅限指定且有效的 owner。</p>
          {members.isError ? (
            <p role="alert">{members.error.message}</p>
          ) : (
            members.data?.map((m) => (
              <MemberEditor
                key={`${m.id}:${m.role}:${m.status}:${m.all_factories}:${m.factory_ids.join(',')}`}
                current={member}
                member={m}
                factories={factories.data ?? []}
                pending={pending}
                save={(body) => mutate(`${base}/members/${m.id}`, body)}
              />
            ))
          )}
          <form
            className="profile-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void mutate(`${base}/approver`, { memberId: form.get('approver') }, 'POST');
            }}
          >
            <label>
              指定审批人
              <select name="approver" defaultValue={member.approver_member_id ?? ''}>
                {members.data
                  ?.filter((m) => m.role === 'owner' && m.status === 'active')
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.display_name}
                    </option>
                  ))}
              </select>
            </label>
            <Button variant="outline" disabled={pending}>
              保存审批人
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
function MemberEditor({
  current,
  member,
  factories,
  pending,
  save,
}: {
  current: MemberView;
  member: WorkspaceMemberView;
  factories: FactoryView[];
  pending: boolean;
  save: (body: unknown) => Promise<void>;
}) {
  const self = current.id === member.id;
  return (
    <form
      className="member-editor"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void save({
          role: form.get('role'),
          status: form.get('status'),
          allFactories: form.get('all') === 'on',
          factoryIds: form.getAll('factory'),
        });
      }}
    >
      <strong>
        {member.display_name}
        {self ? '（本人）' : ''}
      </strong>
      <fieldset disabled={self || pending}>
        <label>
          角色
          <select name="role" defaultValue={member.role}>
            <option value="owner">owner</option>
            <option value="sales">sales</option>
          </select>
        </label>
        <label>
          状态
          <select name="status" defaultValue={member.status}>
            <option value="active">有效</option>
            <option value="disabled">停用</option>
          </select>
        </label>
        <label className="check-label">
          <input type="checkbox" name="all" defaultChecked={member.all_factories} />
          全部工厂
        </label>
        {factories.map((f) => (
          <label key={f.id} className="check-label">
            <input
              type="checkbox"
              name="factory"
              value={f.id}
              defaultChecked={member.factory_ids.includes(f.id)}
            />
            {f.factory_code}
          </label>
        ))}
        {!self && (
          <Button variant="outline" disabled={pending}>
            保存成员权限
          </Button>
        )}
      </fieldset>
    </form>
  );
}
