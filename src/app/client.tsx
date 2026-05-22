'use client'

import { useEffect, useMemo, useState } from 'react'
import type { ComponentType } from 'react'
import {
  Activity,
  CheckCircle2,
  Copy,
  Database,
  ExternalLink,
  Home,
  KeyRound,
  Link2,
  LogIn,
  LogOut,
  MonitorPlay,
  PlayCircle,
  RefreshCw,
  Settings,
  Workflow,
  UserRound,
} from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'

type View = 'home' | 'player' | 'config' | 'status' | 'jobs'

interface ApiState<T> {
  loading: boolean
  error: string
  data: T | null
}

const emptyState = <T,>(): ApiState<T> => ({ loading: false, error: '', data: null })

interface AccountState {
  loggedIn: boolean
  source?: 'env' | 'request' | 'stored'
  uin?: string
  hasEncryptedUin?: boolean
  hasQQMusicKey?: boolean
  actionable?: string
  emby?: {
    username?: string
    hasPassword?: boolean
    generatedPassword?: string
    userId?: string
    hasAccessToken?: boolean
  }
}

interface LoginQrState {
  img: string
  ptqrtoken: number
  qrsig: string
}

interface UserAvatarResult {
  source: 'tx'
  avatarUrl: string
  size: number
}

interface AdminConfig {
  lx: { sourceScriptUrl?: string }
  emby: {
    baseUrl?: string
    apiKey?: string
    hasApiKey?: boolean
    proxyTimeoutMs: number
  }
  gateway: {
    accountMode?: string
  }
  player: {
    ampcastUrl: string
  }
  qq: { enabled: boolean; syncFavorites: boolean; syncPlayHistory: boolean }
}

interface HealthStatus {
  ok: boolean
  checkedAt: string
  database: { ok: boolean; tracks?: number; trackFiles?: number; playEvents?: number; error?: string }
  cache: Record<string, { path: string; exists: boolean; writable: boolean; isDirectory: boolean; entries: number; error?: string }>
  jobs: { byStatus: Record<string, number>; byType?: Record<string, Record<string, number>>; total: number; queued: number; running: number; completed: number; failed: number }
  favorites: { favoriteCount: number; pendingCount: number; failedCount: number }
  resourceCache: { total: number; totalBytes: number; byType: Record<string, { count: number; bytes: number }> }
  config: { missing: string[]; lxMusicSourceScript: boolean }
}

interface JobsResult {
  summary: HealthStatus['jobs']
  items: JobItem[]
}

interface JobItem {
  id: number
  type: string
  status: string
  attempts: number
  error: string | null
  payload: unknown
  createdAt: string
  updatedAt: string
}

interface ConfigDraft {
  embyPassword: string
  qqEnabled: boolean
  qqSyncFavorites: boolean
  qqSyncPlayHistory: boolean
}

interface AccountEmbyConfig {
  username: string
  password: string
  hasPassword: boolean
}

const fetchJson = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init)
  const body = await response.json().catch(() => undefined) as unknown
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body
      ? String((body as { error: unknown }).error)
      : `Request failed: ${response.status}`
    throw new Error(message)
  }
  return body as T
}

const viewMeta: Record<View, { label: string; icon: ComponentType<{ size?: number }> }> = {
  home: { label: '首页', icon: Home },
  player: { label: '播放器', icon: MonitorPlay },
  config: { label: '配置', icon: Settings },
  status: { label: '状态', icon: Activity },
  jobs: { label: '任务', icon: Workflow },
}

const views = Object.keys(viewMeta) as View[]

function parseView(value: string | null): View {
  return value && views.includes(value as View) ? value as View : 'home'
}

export default function MusicClient() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const routeView = parseView(searchParams.get('view'))
  const [view, setView] = useState<View>(routeView)
  const [cookieText, setCookieText] = useState('')
  const [account, setAccount] = useState<ApiState<AccountState>>({ loading: true, error: '', data: null })
  const [loginQr, setLoginQr] = useState<ApiState<LoginQrState>>(emptyState)
  const [avatar, setAvatar] = useState<ApiState<UserAvatarResult>>(emptyState)
  const [accountEmbyConfig, setAccountEmbyConfig] = useState<ApiState<AccountEmbyConfig>>(emptyState)
  const [adminConfig, setAdminConfig] = useState<ApiState<AdminConfig>>(emptyState)
  const [health, setHealth] = useState<ApiState<HealthStatus>>(emptyState)
  const [jobs, setJobs] = useState<ApiState<JobsResult>>(emptyState)
  const [message, setMessage] = useState('')
  const [browserOrigin, setBrowserOrigin] = useState('')
  const [configDraft, setConfigDraft] = useState<ConfigDraft>({
    embyPassword: '',
    qqEnabled: true,
    qqSyncFavorites: true,
    qqSyncPlayHistory: true,
  })

  const embyUrl = browserOrigin
  const ampcastUrl = useMemo(() => {
    const baseUrl = adminConfig.data?.player.ampcastUrl ?? 'https://ampcast.app/'
    if (!embyUrl) return baseUrl
    const url = new URL(baseUrl)
    url.searchParams.set('emby', embyUrl)
    if (account.data?.emby?.username) url.searchParams.set('user', account.data.emby.username)
    return url.toString()
  }, [account.data?.emby?.username, adminConfig.data?.player.ampcastUrl, embyUrl])

  const run = async <T,>(setter: (state: ApiState<T>) => void, task: () => Promise<T>) => {
    setter({ loading: true, error: '', data: null })
    try {
      setter({ loading: false, error: '', data: await task() })
    } catch (error) {
      setter({ loading: false, error: error instanceof Error ? error.message : String(error), data: null })
    }
  }

  const loadAccount = () => run(s => setAccount(s), () => fetchJson<AccountState>('/api/account'))
  const loadAccountEmbyConfig = () => run(s => setAccountEmbyConfig(s), async () => {
    const data = await fetchJson<AccountEmbyConfig>('/api/account/emby')
    setConfigDraft(previous => ({ ...previous, embyPassword: data.password }))
    return data
  })
  const loadHealth = () => run(s => setHealth(s), async () => {
    const response = await fetch('/api/health')
    const body = await response.json().catch(() => undefined) as HealthStatus | undefined
    if (!body) throw new Error(`Request failed: ${response.status}`)
    return body
  })
  const loadJobs = () => run(s => setJobs(s), () => fetchJson<JobsResult>('/api/jobs?limit=100'))
  const loadAdminConfig = () => run(s => setAdminConfig(s), async () => {
    const data = await fetchJson<AdminConfig>('/api/admin/config')
    setConfigDraft({
      embyPassword: '',
      qqEnabled: data.qq.enabled,
      qqSyncFavorites: data.qq.syncFavorites,
      qqSyncPlayHistory: data.qq.syncPlayHistory,
    })
    return data
  })

  const login = async () => {
    setMessage('')
    await run(s => setAccount(s), () => fetchJson<AccountState>('/api/account/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cookie: cookieText, persist: true }),
    }))
    setCookieText('')
    await loadAdminConfig()
  }

  const requestLoginQr = () => {
    setMessage('')
    run(s => setLoginQr(s), () => fetchJson<LoginQrState>('/api/account/qr'))
  }

  const checkLoginQr = async () => {
    const qr = loginQr.data
    if (!qr) return
    setMessage('')
    await run(s => setAccount(s), async () => {
      const result = await fetchJson<
        | { isOk: false; refresh: boolean; message: string }
        | { isOk: true; message: string; account: AccountState }
      >('/api/account/qr/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ptqrtoken: qr.ptqrtoken, qrsig: qr.qrsig, persist: true }),
      })

      if (!result.isOk) {
        setMessage(result.message)
        return account.data ?? { loggedIn: false }
      }

      setLoginQr(emptyState())
      setMessage(result.message)
      return result.account
    })
    await loadAdminConfig()
  }

  const logout = async () => {
    setMessage('')
    await run(s => setAccount(s), async () => {
      await fetchJson<{ loggedIn: false }>('/api/account', { method: 'DELETE' })
      return { loggedIn: false }
    })
  }

  const openView = (next: View) => {
    setView(next)
    router.push(next === 'home' ? '/' : `/?view=${next}`)
    loadViewData(next)
  }

  const loadViewData = (next: View) => {
    if (next === 'home' || next === 'player' || next === 'config') loadAdminConfig()
    if (next === 'config') loadAccountEmbyConfig()
    if (next === 'status') loadHealth()
    if (next === 'jobs') loadJobs()
  }

  const saveAdminConfig = async () => {
    setMessage('')
    if (configDraft.embyPassword.trim()) {
      await run(s => setAccountEmbyConfig(s), () => fetchJson<AccountEmbyConfig>('/api/account/emby', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: configDraft.embyPassword }),
      }))
    }
    const payload: Record<string, unknown> = {
      qqEnabled: configDraft.qqEnabled,
      qqSyncFavorites: configDraft.qqSyncFavorites,
      qqSyncPlayHistory: configDraft.qqSyncPlayHistory,
    }
    await run(s => setAdminConfig(s), () => fetchJson<AdminConfig>('/api/admin/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }))
    setMessage('配置已保存')
  }

  useEffect(() => {
    setBrowserOrigin(window.location.origin)
    void loadAccount()
  }, [])

  useEffect(() => {
    setView(routeView)
    if (account.data?.loggedIn) loadViewData(routeView)
  }, [routeView, account.data?.loggedIn])

  useEffect(() => {
    if (!account.data?.loggedIn || !account.data.uin) {
      setAvatar(emptyState())
      return
    }
    void run(s => setAvatar(s), () => fetchJson<UserAvatarResult>(`/api/user/avatar?uin=${encodeURIComponent(account.data!.uin!)}&size=100`))
  }, [account.data?.loggedIn, account.data?.uin])

  if (account.loading && !account.data) {
    return (
      <main className="login-screen">
        <div className="login-card compact">
          <RefreshCw className="spin" size={24} />
          <p>正在检查登录状态...</p>
        </div>
      </main>
    )
  }

  if (!account.data?.loggedIn) {
    return (
      <main className="login-screen">
        <LoginPage
          account={account}
          cookieText={cookieText}
          onCookieTextChange={setCookieText}
          onLogin={login}
          loginQr={loginQr}
          onRequestLoginQr={requestLoginQr}
          onCheckLoginQr={checkLoginQr}
          message={message}
        />
      </main>
    )
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">
            <img src="/public/logo.svg" alt="" />
          </div>
          <div>
            <h1>XMusic</h1>
            <span>Emby 音乐网关</span>
          </div>
        </div>
        <nav className="tabs" aria-label="主导航">
          {views.map(key => {
            const Icon = viewMeta[key].icon
            return (
              <button key={key} className={view === key ? 'active' : ''} onClick={() => openView(key)}>
                <Icon size={17} />
                <span>{viewMeta[key].label}</span>
              </button>
            )
          })}
        </nav>
        <AccountSummary account={account.data} avatarUrl={avatar.data?.avatarUrl} onLogout={logout} />
      </aside>

      <section className="content">
        <header className="content-header">
          <div>
            <p className="eyebrow">{viewMeta[view].label}</p>
            <h2>{headingFor(view)}</h2>
          </div>
          <div className="header-actions">
            <span className="account-pill">QQ {account.data.uin}</span>
          </div>
        </header>

        {message ? <p className="status notice">{message}</p> : null}

        {view === 'home' && (
          <section className="workspace">
            <Status state={adminConfig} />
            <HomePanel embyUrl={embyUrl} ampcastUrl={ampcastUrl} onOpenConfig={() => openView('config')} />
          </section>
        )}

        {view === 'player' && (
          <section className="workspace">
            <Status state={adminConfig} />
            <PlayerPanel config={adminConfig.data} embyUrl={embyUrl} ampcastUrl={ampcastUrl} />
          </section>
        )}

        {view === 'config' && (
          <section className="workspace">
            <div className="section-head">
              <h3>服务配置</h3>
              <IconButton label="刷新" onClick={loadAdminConfig} disabled={adminConfig.loading}><RefreshCw size={16} /></IconButton>
            </div>
            <Status state={adminConfig} />
            <ConfigPanel
              draft={configDraft}
              embyConfig={accountEmbyConfig}
              embyHost={embyUrl}
              onChange={setConfigDraft}
              onSave={saveAdminConfig}
              loading={adminConfig.loading || accountEmbyConfig.loading}
            />
          </section>
        )}

        {view === 'status' && (
          <section className="workspace">
            <div className="section-head">
              <h3>运行状态</h3>
              <div className="toolbar">
                <button className="secondary-button" onClick={() => openView('jobs')}><Workflow size={16} />查看任务</button>
                <IconButton label="刷新" onClick={loadHealth} disabled={health.loading}><RefreshCw size={16} /></IconButton>
              </div>
            </div>
            <Status state={health} />
            {health.data ? <HealthPanel health={health.data} onOpenJobs={() => openView('jobs')} /> : null}
          </section>
        )}

        {view === 'jobs' && (
          <section className="workspace">
            <div className="section-head">
              <h3>任务列表</h3>
              <IconButton label="刷新" onClick={loadJobs} disabled={jobs.loading}><RefreshCw size={16} /></IconButton>
            </div>
            <Status state={jobs} />
            {jobs.data ? <JobsPanel jobs={jobs.data} /> : null}
          </section>
        )}
      </section>
    </main>
  )
}

function LoginPage({
  account,
  cookieText,
  onCookieTextChange,
  onLogin,
  loginQr,
  onRequestLoginQr,
  onCheckLoginQr,
  message,
}: {
  account: ApiState<AccountState>
  cookieText: string
  onCookieTextChange: (value: string) => void
  onLogin: () => void
  loginQr: ApiState<LoginQrState>
  onRequestLoginQr: () => void
  onCheckLoginQr: () => void
  message: string
}) {
  return (
    <section className="login-card">
      <div className="brand-lockup login-brand">
        <div className="brand-mark">
          <img src="/public/logo.svg" alt="" />
        </div>
        <div>
          <h1>XMusic</h1>
          <span>登录后进入 Emby 音乐网关</span>
        </div>
      </div>
      <div className="login-methods">
        <section>
          <h2>QQ 扫码登录</h2>
          {loginQr.data ? (
            <div className="qr-login large">
              <img src={loginQr.data.img} alt="QQ 登录二维码" />
              <button onClick={onCheckLoginQr} disabled={account.loading}><RefreshCw size={16} />检查扫码状态</button>
            </div>
          ) : (
            <button onClick={onRequestLoginQr} disabled={loginQr.loading}><LogIn size={16} />获取登录二维码</button>
          )}
          <Status state={loginQr} />
        </section>
        <section>
          <h2>粘贴 Cookie 登录</h2>
          <textarea value={cookieText} onChange={event => onCookieTextChange(event.target.value)} placeholder="粘贴 y.qq.com 已登录请求里的 Cookie" />
          <button onClick={onLogin} disabled={account.loading || !cookieText.trim()}><KeyRound size={16} />保存 Cookie</button>
        </section>
      </div>
      {message ? <p className="status notice">{message}</p> : null}
      <Status state={account} />
    </section>
  )
}

function AccountSummary({ account, avatarUrl, onLogout }: { account: AccountState; avatarUrl?: string; onLogout: () => void }) {
  return (
    <section className="account-panel">
      <div className="section-head">
        <h3>当前帐号</h3>
        <button className="ghost-button" onClick={onLogout}><LogOut size={16} />登出</button>
      </div>
      <div className="account-summary">
        {avatarUrl ? <img src={avatarUrl} alt="" /> : <div className="avatar-placeholder">{account.uin?.slice(-2) ?? 'QQ'}</div>}
        <dl className="account-facts">
          <div><dt>QQ</dt><dd>{account.uin}</dd></div>
          <div><dt>Emby</dt><dd>{account.emby?.username ?? account.uin}</dd></div>
          <div><dt>来源</dt><dd>{account.source}</dd></div>
          <div><dt>Key</dt><dd>{account.hasQQMusicKey ? 'ready' : 'missing'}</dd></div>
        </dl>
      </div>
    </section>
  )
}

function HomePanel({
  embyUrl,
  ampcastUrl,
  onOpenConfig,
}: {
  embyUrl: string
  ampcastUrl: string
  onOpenConfig: () => void
}) {
  return (
    <div className="home-layout">
      <section className="intro-panel">
        <h3>产品架构</h3>
        <p>XMusic 现在作为 QQ 音乐到 Emby 的网关运行。搜索、排行、歌单、收藏、历史和猜你喜欢不再作为独立页面维护，统一通过对外提供的 Emby 服务暴露给播放器。</p>
        <p>Web 端主要负责登录、服务配置、连接信息和运行状态检查；实际播放与服务可用性测试交给 ampcast。</p>
      </section>
      <section className="quick-grid">
        <InfoCard icon={Link2} title="对外 Emby 地址" value={embyUrl || '-'} copyValue={embyUrl} />
        <InfoCard icon={UserRound} title="UserName" value="QQ + 当前 QQ 号" />
        <InfoCard icon={KeyRound} title="PWD" value="配置页可查看和修改" />
        <InfoCard icon={MonitorPlay} title="ampcast" value="打开播放器测试服务" href={ampcastUrl} />
      </section>
      <section className="steps-panel">
        <h3>使用说明</h3>
        <ol>
          <li>登录后在配置页确认 XMusic 对外提供的 Emby Host、UserName 和 PWD。</li>
          <li>UserName 默认使用 QQ + 当前 QQ 号，PWD 可在配置页修改。</li>
          <li>打开播放器页，用 ampcast 连接当前服务的 Emby 地址进行播放测试。</li>
          <li>在状态页确认数据库、缓存目录、后台任务和同步状态。</li>
        </ol>
        <button onClick={onOpenConfig}><Settings size={16} />进入配置</button>
      </section>
    </div>
  )
}

function PlayerPanel({ config, embyUrl, ampcastUrl }: { config: AdminConfig | null; embyUrl: string; ampcastUrl: string }) {
  return (
    <div className="player-layout">
      <section className="ampcast-panel">
        <div>
          <h3>ampcast 播放器</h3>
          <p>使用 rekkyrosso/ampcast 连接当前服务对外提供的 Emby 地址。登录时选择 Emby，服务器填写下方地址，用户名使用 QQ + 当前 QQ 号，密码使用登录 XMusic 时自动生成的播放器密码。</p>
        </div>
        <div className="player-actions">
          <a className="primary-link" href={ampcastUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} />打开 ampcast</a>
          <CopyButton value={embyUrl} label="复制 Emby 地址" />
        </div>
        <iframe title="ampcast" src={ampcastUrl} />
      </section>
      <section className="connection-panel">
        <h3>连接参数</h3>
        <dl className="connection-list">
          <div><dt>服务器</dt><dd>{embyUrl || '-'}</dd></div>
          <div><dt>用户名</dt><dd>{config?.gateway.accountMode === 'per-account' ? 'QQ + 当前 QQ 号' : '-'}</dd></div>
          <div><dt>密码</dt><dd>账号首次登录时生成</dd></div>
        </dl>
      </section>
    </div>
  )
}

function ConfigPanel({
  draft,
  embyConfig,
  embyHost,
  onChange,
  onSave,
  loading,
}: {
  draft: ConfigDraft
  embyConfig: ApiState<AccountEmbyConfig>
  embyHost: string
  onChange: (value: ConfigDraft) => void
  onSave: () => void
  loading: boolean
}) {
  const patch = (value: Partial<ConfigDraft>) => onChange({ ...draft, ...value })
  return (
    <div className="config-grid">
      <section>
        <h3>Emby 配置</h3>
        <dl className="connection-list">
          <div>
            <dt>Host</dt>
            <dd><span>{embyHost || '-'}</span><CopyButton value={embyHost} label="复制 Host" iconOnly /></dd>
          </div>
          <div>
            <dt>UserName</dt>
            <dd><span>{embyConfig.data?.username ?? '-'}</span><CopyButton value={embyConfig.data?.username ?? ''} label="复制 UserName" iconOnly /></dd>
          </div>
        </dl>
        <Status state={embyConfig} />
        <label>
          <span>PWD</span>
          <input value={draft.embyPassword} onChange={event => patch({ embyPassword: event.target.value })} placeholder="播放器登录密码" />
        </label>
      </section>
      <section>
        <h3>QQ 同步</h3>
        <label className="check-row">
          <input type="checkbox" checked={draft.qqEnabled} onChange={event => patch({ qqEnabled: event.target.checked })} />
          <span>启用 QQ 帐号能力</span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={draft.qqSyncFavorites} onChange={event => patch({ qqSyncFavorites: event.target.checked })} />
          <span>同步收藏到 Emby 架构</span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={draft.qqSyncPlayHistory} onChange={event => patch({ qqSyncPlayHistory: event.target.checked })} />
          <span>同步播放历史</span>
        </label>
      </section>
      <div className="form-actions">
        <button onClick={onSave} disabled={loading}>保存配置</button>
      </div>
    </div>
  )
}

function HealthPanel({ health, onOpenJobs }: { health: HealthStatus; onOpenJobs: () => void }) {
  const blockedCache = Object.entries(health.cache).filter(([, item]) => !item.exists || !item.writable || !item.isDirectory)
  return (
    <div className="ops-layout">
      <section className={health.ok ? 'status-banner ok' : 'status-banner attention'}>
        <div>
          <span>{health.ok ? 'OK' : 'Needs Attention'}</span>
          <h3>{health.ok ? '核心依赖可用' : '需要处理运行问题'}</h3>
          <p>最后检查 {formatDateTime(health.checkedAt)}</p>
        </div>
        <button className="secondary-button" onClick={onOpenJobs}><Workflow size={16} />任务列表</button>
      </section>

      <section className="metric-grid">
        <MetricCard icon={Database} label="Database" value={health.database.ok ? 'ready' : 'error'} detail={`tracks ${health.database.tracks ?? 0} · files ${health.database.trackFiles ?? 0} · plays ${health.database.playEvents ?? 0}`} tone={health.database.ok ? 'ok' : 'bad'} />
        <MetricCard icon={Workflow} label="Jobs" value={`${health.jobs.queued} queued`} detail={`running ${health.jobs.running} · failed ${health.jobs.failed} · completed ${health.jobs.completed}`} tone={health.jobs.failed ? 'bad' : health.jobs.queued ? 'warn' : 'ok'} />
        <MetricCard icon={PlayCircle} label="Resource Cache" value={`${health.resourceCache.total} files`} detail={formatBytes(health.resourceCache.totalBytes)} tone="ok" />
        <MetricCard icon={KeyRound} label="Config" value={health.config.missing.length ? 'missing' : 'ready'} detail={health.config.missing.length ? health.config.missing.join(', ') : 'LX source configured'} tone={health.config.missing.length ? 'bad' : 'ok'} />
      </section>

      <section className="ops-grid">
        <article>
          <h3>目录状态</h3>
          <div className="status-table">
            {Object.entries(health.cache).map(([name, item]) => (
              <div key={name}>
                <span>{name}</span>
                <strong>{item.writable ? 'writable' : 'blocked'}</strong>
                <small>{item.entries} entries</small>
              </div>
            ))}
          </div>
          {blockedCache.length ? <p className="status error">目录不可写：{blockedCache.map(([name]) => name).join(', ')}</p> : null}
        </article>

        <article>
          <h3>资源缓存</h3>
          <div className="status-table">
            {Object.entries(health.resourceCache.byType).length ? Object.entries(health.resourceCache.byType).map(([type, item]) => (
              <div key={type}>
                <span>{type}</span>
                <strong>{item.count}</strong>
                <small>{formatBytes(item.bytes)}</small>
              </div>
            )) : <p>暂无资源缓存</p>}
          </div>
        </article>

        <article>
          <h3>任务类型</h3>
          <div className="status-table">
            {Object.entries(health.jobs.byType ?? {}).length ? Object.entries(health.jobs.byType ?? {}).map(([type, counts]) => (
              <div key={type}>
                <span>{type}</span>
                <strong>{counts.running ?? 0} running</strong>
                <small>{counts.queued ?? 0} queued · {counts.failed ?? 0} failed</small>
              </div>
            )) : <p>暂无任务</p>}
          </div>
        </article>

        <article>
          <h3>收藏同步</h3>
          <p>local {health.favorites.favoriteCount} · pending {health.favorites.pendingCount} · failed {health.favorites.failedCount}</p>
        </article>
      </section>
    </div>
  )
}

function JobsPanel({ jobs }: { jobs: JobsResult }) {
  return (
    <div className="jobs-layout">
      <section className="metric-grid">
        <MetricCard icon={Workflow} label="Total" value={String(jobs.summary.total)} detail="all jobs" tone="ok" />
        <MetricCard icon={RefreshCw} label="Queued" value={String(jobs.summary.queued)} detail={`${jobs.summary.running} running`} tone={jobs.summary.queued ? 'warn' : 'ok'} />
        <MetricCard icon={CheckCircle2} label="Completed" value={String(jobs.summary.completed)} detail="finished jobs" tone="ok" />
        <MetricCard icon={Activity} label="Failed" value={String(jobs.summary.failed)} detail="needs action" tone={jobs.summary.failed ? 'bad' : 'ok'} />
      </section>

      <section className="jobs-table">
        <div className="job-row header">
          <span>ID</span>
          <span>Type</span>
          <span>Status</span>
          <span>Attempts</span>
          <span>Updated</span>
          <span>Error</span>
        </div>
        {jobs.items.map(job => (
          <div className="job-row" key={job.id}>
            <span>#{job.id}</span>
            <span>{job.type}</span>
            <span><StatusBadge status={job.status} /></span>
            <span>{job.attempts}</span>
            <span>{formatDateTime(job.updatedAt)}</span>
            <span title={job.error ?? ''}>{job.error ?? payloadSummary(job.payload)}</span>
          </div>
        ))}
        {!jobs.items.length ? <p>暂无任务记录</p> : null}
      </section>
    </div>
  )
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: ComponentType<{ size?: number }>
  label: string
  value: string
  detail: string
  tone: 'ok' | 'warn' | 'bad'
}) {
  return (
    <article className={`metric-card ${tone}`}>
      <Icon size={18} />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  )
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge ${status}`}>{status}</span>
}

function InfoCard({
  icon: Icon,
  title,
  value,
  copyValue,
  href,
}: {
  icon: ComponentType<{ size?: number }>
  title: string
  value: string
  copyValue?: string
  href?: string
}) {
  return (
    <article className="info-card">
      <Icon size={18} />
      <div>
        <span>{title}</span>
        {href ? <a href={href} target="_blank" rel="noreferrer">{value}</a> : <strong>{value}</strong>}
      </div>
      {copyValue ? <CopyButton value={copyValue} label={`复制${title}`} iconOnly /> : null}
    </article>
  )
}

function CopyButton({ value, label, iconOnly = false }: { value: string; label: string; iconOnly?: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className={iconOnly ? 'icon-button' : 'secondary-button'}
      aria-label={label}
      title={label}
      onClick={() => {
        if (!value) return
        copyText(value)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      }}
      disabled={!value}
    >
      {copied ? <CheckCircle2 size={16} /> : <Copy size={16} />}
      {iconOnly ? null : label}
    </button>
  )
}

function copyText(value: string): void {
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  document.body.appendChild(textarea)
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

function IconButton({ label, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button className="icon-button" aria-label={label} title={label} {...props}>
      {children}
    </button>
  )
}

function Status<T>({ state }: { state: ApiState<T> }) {
  if (state.loading) return <p className="status">加载中...</p>
  if (state.error) return <p className="status error">{state.error}</p>
  return null
}

function headingFor(view: View): string {
  if (view === 'home') return '产品说明与连接信息'
  if (view === 'player') return '使用 ampcast 测试 Emby 服务'
  if (view === 'config') return '配置上游与对外帐号'
  if (view === 'jobs') return '后台任务队列'
  return '系统运行状态'
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let next = value
  let unit = 0
  while (next >= 1024 && unit < units.length - 1) {
    next /= 1024
    unit += 1
  }
  return `${next.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function payloadSummary(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>
  return [record.source, record.songmid, record.quality, record.playlistId]
    .filter(value => typeof value === 'string' || typeof value === 'number')
    .join(' · ')
}
