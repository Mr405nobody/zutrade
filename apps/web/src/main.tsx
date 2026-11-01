import { OutboundPanel } from './outbound';
import { ApprovalPanel } from './approvals';
import { ProspectingPanel } from './prospecting';
import { OutreachPanel } from './outreach';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Box, ClipboardCheck, MessageCircle, Search, Settings2, X } from 'lucide-react';
import { identityViewSchema, readinessSchema } from '@zutrade/contracts';
import { Button } from '@zutrade/ui';
import { IdentityPanel } from './identity';
import { Inbox } from './inbox';
import { ProductsPanel, SupplyTasks } from './supply';
import './styles.css';

const entries = [
  { label: '消息', icon: MessageCircle, stage: 'A2', description: '' },
  {
    label: '找客户',
    icon: Search,
    stage: 'D1',
    description: '企业发现将在 D1 开放，从真实公开来源研究企业并保留可核对的来源。',
  },
  {
    label: '产品',
    icon: Box,
    stage: 'B',
    description:
      '产品资料与供给证据将在 B 阶段开放。当前买家提出的数量与到货要求仅为需求，尚未经工厂确认。',
  },
  {
    label: '待办',
    icon: ClipboardCheck,
    stage: 'C / D2',
    description: '报价审批、结果核对与自动跟进将在对应阶段开放。当前可在消息中查看模拟发送状态。',
  },
] as const;

function HealthPanel() {
  const health = useQuery({
    queryKey: ['infrastructure-health'],
    queryFn: async () => {
      const response = await fetch('/health/ready', {
        signal: AbortSignal.timeout(5000),
        cache: 'no-store',
      });
      if (![200, 503].includes(response.status)) throw new Error('无法取得健康信息');
      return readinessSchema.parse(await response.json());
    },
    refetchInterval: 3000,
    retry: false,
  });
  const snapshot =
    health.fetchStatus === 'paused' || Date.now() - health.dataUpdatedAt > 10000
      ? undefined
      : health.data;
  return (
    <section className="health-section">
      <div className="section-heading">
        <div className="section-title">
          <Activity size={21} />
          <div>
            <h2>本地服务状态</h2>
            <p>从服务端读取 · 每 3 秒更新</p>
          </div>
        </div>
        <Button
          variant="outline"
          onClick={() => void health.refetch()}
          disabled={health.isFetching}
        >
          刷新
        </Button>
      </div>
      <div className="health-grid">
        {(['database', 'worker'] as const).map((key) => (
          <article
            aria-label={`${key === 'database' ? 'PostgreSQL' : 'Worker'} 健康状态`}
            key={key}
            className={`health-card health-${snapshot?.[key].status ?? 'unknown'}`}
          >
            <h3>{key === 'database' ? 'PostgreSQL' : 'Worker'}</h3>
            <p>
              {health.isPending
                ? '正在检查…'
                : (snapshot?.[key].detail ?? '连接中断或状态已过期，请检查服务')}
            </p>
            <span className={`status-${snapshot?.[key].status ?? 'unknown'}`}>
              {snapshot?.[key].status === 'ok' ? '可用' : '未就绪'}
            </span>
          </article>
        ))}
      </div>
      <div className="health-footer">
        <span>消息：simulation · AI：mock/preset · 企业发现：真实公开来源</span>
        <a href="/health/ready" target="_blank" rel="noreferrer">
          查看原始探针
        </a>
      </div>
    </section>
  );
}

function App() {
  const cache = useQueryClient();
  const [active, setActive] = useState(() =>
    /^\/(outbound|prospecting)(?:\/|$)/.test(window.location.pathname) ? 1 : 0,
  );
  const [outbound, setOutbound] = useState(window.location.pathname.startsWith('/outbound'));
  useEffect(() => {
    const update = () => {
      setActive(/^\/(outbound|prospecting)(?:\/|$)/.test(window.location.pathname) ? 1 : 0);
      setOutbound(window.location.pathname.startsWith('/outbound'));
    };
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  const [focusedThread, setFocusedThread] = useState<string | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      setFocusedThread((event as CustomEvent<string>).detail);
      setActive(0);
      setSettings(false);
    };
    window.addEventListener('zutrade-open-thread', open);
    return () => window.removeEventListener('zutrade-open-thread', open);
  }, []);
  const [settings, setSettings] = useState(false);
  const [workspaceId, setWorkspaceId] = useState('');
  const identity = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const response = await fetch('/api/me', { credentials: 'include', cache: 'no-store' });
      if (response.status === 401) return null;
      if (!response.ok) throw new Error('无法读取身份，请重新检查登录或成员状态');
      return identityViewSchema.parse(await response.json());
    },
    retry: false,
    refetchInterval: 10000,
  });
  const member =
    identity.data?.memberships.find((m) => m.workspace_id === workspaceId) ??
    identity.data?.memberships[0];
  useEffect(() => {
    if (!member || identity.isError) {
      setWorkspaceId('');
      cache.removeQueries({ queryKey: ['inbox'] });
    }
  }, [identity.data, identity.isError, member?.id, cache]);
  const current = entries[active] ?? entries[0];
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="ZuTrade 首页">
          <span className="brand-mark">Z</span>
          <strong>ZuTrade</strong>
        </a>
        <span className="topbar-divider" />
        <span className="environment-label">模拟消息工作台</span>
        <div className="topbar-right">
          <span className="stage-pill">模拟 AI</span>
          <button
            className={`settings-button ${settings ? 'selected' : ''}`}
            onClick={() => setSettings(!settings)}
            aria-label={settings ? '返回消息工作台' : '工作区与设置'}
          >
            {settings ? <X size={18} /> : <Settings2 size={18} />}
            <span>{identity.data?.user.display_name ?? '登录与设置'}</span>
          </button>
        </div>
      </header>
      <div className="workspace">
        <nav className="navigation" aria-label="主导航">
          {entries.map((entry, index) => (
            <button
              key={entry.label}
              className={`nav-item ${active === index && !settings ? 'selected' : ''}`}
              onClick={() => {
                if (index === 1) {
                  window.location.assign('/outbound');
                  return;
                }
                window.history.pushState({}, '', '/');
                setActive(index);
                setSettings(false);
              }}
              aria-current={active === index && !settings ? 'page' : undefined}
            >
              <entry.icon size={24} strokeWidth={1.7} />
              <span>{entry.label}</span>
            </button>
          ))}
          <button
            className="nav-bottom"
            onClick={() => setSettings(true)}
            aria-label="身份、工厂、成员与健康检查"
          >
            <Settings2 size={21} />
            <span>工作区</span>
          </button>
        </nav>
        {settings || !member || identity.isError ? (
          <main className="settings-panel">
            <div className="settings-title">
              <div>
                <div className="eyebrow">WORKSPACE / LOCAL</div>
                <h1>身份与工作区</h1>
              </div>
              {member && (
                <Button variant="outline" onClick={() => setSettings(false)}>
                  返回消息
                </Button>
              )}
            </div>
            <IdentityPanel />
            <HealthPanel />
          </main>
        ) : active === 0 ? (
          <Inbox
            key={`${member.id}:${member.workspace_id}`}
            member={member}
            initialThreadId={focusedThread}
            memberships={identity.data?.memberships ?? []}
            onWorkspaceChange={setWorkspaceId}
          />
        ) : active === 1 && outbound ? (
          <OutboundPanel key={member.id} member={member} />
        ) : active === 1 ? (
          <div className="d2-prospecting">
            <a className="outbound-entry" href="/outbound">
              打开主动获客与企业背调 →
            </a>
            <ProspectingPanel key={member.id} member={member} />
            <OutreachPanel key={`outreach:${member.id}`} member={member} />
          </div>
        ) : active === 2 ? (
          <ProductsPanel key={member.id} member={member} />
        ) : active === 3 ? (
          <div className="dispatch-tasks">
            <OutreachPanel key={`d2-tasks:${member.id}`} member={member} tasks />
            <ApprovalPanel key={`approvals:${member.id}`} member={member} />
            <SupplyTasks
              key={`supply:${member.id}`}
              member={member}
              openProducts={() => setActive(2)}
            />
          </div>
        ) : (
          <main className="future-panel">
            <current.icon size={45} strokeWidth={1.2} />
            <h1>{current.label}</h1>
            <p>{current.description}</p>
            <span className="future-stage">阶段 {current.stage}</span>
            <Button variant="outline" onClick={() => setActive(0)}>
              返回消息
            </Button>
          </main>
        )}
      </div>
    </div>
  );
}
const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: true } } });
const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
