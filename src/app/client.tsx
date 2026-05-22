'use client'

import { useEffect, useMemo, useState } from 'react'
import type { ComponentType } from 'react'
import {
  Activity,
  BadgeCheck,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Copy,
  Database,
  Eye,
  EyeOff,
  ExternalLink,
  Home,
  KeyRound,
  Link2,
  LogIn,
  LogOut,
  MonitorPlay,
  Music2,
  PlayCircle,
  RefreshCw,
  Settings,
  Sparkles,
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

type LoginQrPhase = 'idle' | 'active' | 'checking' | 'expired' | 'error'

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
  qqEnabled: boolean
  qqSyncFavorites: boolean
  qqSyncPlayHistory: boolean
}

interface AccountEmbyConfig {
  username: string
  password: string
  hasPassword: boolean
}

interface ConnectionInfo {
  server: string
  username: string
  password: string
}

const playerRecommendations = [
  { name: 'ampcast', platform: 'Web / Desktop', href: 'https://ampcast.app/' },
  { name: '箭头音乐', platform: 'iOS / Android / Desktop', href: 'https://cn.amcfy.com/' },
  { name: '音流', platform: 'iOS / Android / Desktop', href: 'https://music.aqzscn.cn/' },
  { name: 'VutronMusic', platform: 'Windows / macOS / Linux', href: 'https://github.com/stark81/VutronMusic' },
]

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
  const [loginQrPhase, setLoginQrPhase] = useState<LoginQrPhase>('idle')
  const [avatar, setAvatar] = useState<ApiState<UserAvatarResult>>(emptyState)
  const [accountEmbyConfig, setAccountEmbyConfig] = useState<ApiState<AccountEmbyConfig>>(emptyState)
  const [adminConfig, setAdminConfig] = useState<ApiState<AdminConfig>>(emptyState)
  const [health, setHealth] = useState<ApiState<HealthStatus>>(emptyState)
  const [jobs, setJobs] = useState<ApiState<JobsResult>>(emptyState)
  const [message, setMessage] = useState('')
  const [browserOrigin, setBrowserOrigin] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [configDraft, setConfigDraft] = useState<ConfigDraft>({
    qqEnabled: true,
    qqSyncFavorites: true,
    qqSyncPlayHistory: true,
  })

  const embyUrl = browserOrigin
  const ampcastUrl = useMemo(() => {
    const baseUrl = adminConfig.data?.player.ampcastUrl ?? 'https://ampcast.app/'
    return new URL(baseUrl).toString()
  }, [adminConfig.data?.player.ampcastUrl])
  const connectionInfo: ConnectionInfo = {
    server: embyUrl,
    username: accountEmbyConfig.data?.username ?? account.data?.emby?.username ?? '',
    password: accountEmbyConfig.data?.password ?? account.data?.emby?.generatedPassword ?? '',
  }

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
    await loadAccountEmbyConfig()
  }

  const requestLoginQr = () => {
    setMessage('')
    setLoginQrPhase('idle')
    run(s => setLoginQr(s), () => fetchJson<LoginQrState>('/api/account/qr'))
  }

  const checkLoginQr = async () => {
    const qr = loginQr.data
    if (!qr) return
    setLoginQrPhase('checking')
    setMessage('')
    try {
      const result = await fetchJson<
      | { isOk: false; refresh: boolean; status?: 'pending' | 'scanned' | 'expired'; message: string }
      | { isOk: true; message: string; account: AccountState }
    >('/api/account/qr/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ptqrtoken: qr.ptqrtoken, qrsig: qr.qrsig, persist: true }),
    })

      if (!result.isOk) {
        setMessage(result.message)
        setLoginQrPhase(result.refresh ? 'expired' : 'active')
        return
      }

      setLoginQr(emptyState())
      setLoginQrPhase('idle')
      setMessage(result.message)
      setAccount({ loading: false, error: '', data: result.account })
      await loadAdminConfig()
      await loadAccountEmbyConfig()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setMessage(message)
      setLoginQrPhase('error')
      setAccount(current => ({ ...current, loading: false, error: message }))
    }
  }

  const logout = async () => {
    setMessage('')
    await run(s => setAccount(s), async () => {
      await fetchJson<{ loggedIn: false }>('/api/account', { method: 'DELETE' })
      return { loggedIn: false }
    })
  }

  const openView = (next: View) => {
    setMessage('')
    setView(next)
    router.push(next === 'home' ? '/' : `/?view=${next}`)
    loadViewData(next)
  }

  const loadViewData = (next: View) => {
    if (next === 'home' || next === 'player' || next === 'config') loadAdminConfig()
    if (next === 'home' || next === 'player' || next === 'config') loadAccountEmbyConfig()
    if (next === 'status') loadHealth()
    if (next === 'jobs') loadJobs()
  }

  const regeneratePassword = async () => {
    setMessage('')
    await run(s => setAccountEmbyConfig(s), () => fetchJson<AccountEmbyConfig>('/api/account/emby', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'regenerate-password' }),
    }))
    setMessage('播放器密码已重置，请重新连接')
  }

  const saveAdminConfig = async () => {
    setMessage('')
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
    if (account.data?.loggedIn) void loadAccountEmbyConfig()
  }, [account.data?.loggedIn])

  useEffect(() => {
    if (!account.data?.loggedIn || !account.data.uin) {
      setAvatar(emptyState())
      return
    }
    void run(s => setAvatar(s), () => fetchJson<UserAvatarResult>(`/api/user/avatar?uin=${encodeURIComponent(account.data!.uin!)}&size=100`))
  }, [account.data?.loggedIn, account.data?.uin])

  useEffect(() => {
    if (loginQr.data && loginQrPhase === 'idle') setLoginQrPhase('active')
  }, [loginQr.data, loginQrPhase])

  useEffect(() => {
    if (!loginQr.data || loginQrPhase !== 'active' || account.data?.loggedIn) return

    const timer = window.setInterval(() => {
      void checkLoginQr()
    }, 2500)

    return () => window.clearInterval(timer)
  }, [loginQr.data, loginQrPhase, account.data?.loggedIn])

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
          loginQrPhase={loginQrPhase}
          onRequestLoginQr={requestLoginQr}
          onCheckLoginQr={checkLoginQr}
          message={message}
        />
      </main>
    )
  }

  return (
    <main className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">
            <img src="/public/logo.svg" alt="" />
          </div>
          <div>
            <h1>XMusic</h1>
            <span>把音乐装进自己口袋</span>
          </div>
          <button className="collapse-button" onClick={() => setSidebarCollapsed(value => !value)} aria-label={sidebarCollapsed ? '展开导航' : '收起导航'} title={sidebarCollapsed ? '展开导航' : '收起导航'}>
            {sidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
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
        {view === 'home' ? null : (
          <header className="content-header">
            <h2>{headingFor(view)}</h2>
            {view === 'player' ? (
              <a className="secondary-button compact-button" href={ampcastUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />新窗口打开</a>
            ) : null}
          </header>
        )}

        {message ? <p className="toast-message">{message}</p> : null}

        {view === 'home' && (
          <section className="workspace">
            <Status state={adminConfig} />
            <HomePanel connection={connectionInfo} ampcastUrl={ampcastUrl} onOpenConfig={() => openView('config')} />
          </section>
        )}

        {view === 'player' && (
          <section className="workspace">
            <Status state={adminConfig} />
            <PlayerPanel ampcastUrl={ampcastUrl} />
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
              connection={connectionInfo}
              onChange={setConfigDraft}
              onSave={saveAdminConfig}
              onRegeneratePassword={regeneratePassword}
              loading={adminConfig.loading || accountEmbyConfig.loading}
            />
          </section>
        )}

        {view === 'status' && (
          <section className="workspace">
            <div className="section-head">
              <h3>运行状态</h3>
              <div className="toolbar">
                <IconButton label="刷新" onClick={loadHealth} disabled={health.loading}><RefreshCw size={16} /></IconButton>
              </div>
            </div>
            <Status state={health} />
            {health.data ? <HealthPanel health={health.data} /> : null}
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
  loginQrPhase,
  onRequestLoginQr,
  onCheckLoginQr,
  message,
}: {
  account: ApiState<AccountState>
  cookieText: string
  onCookieTextChange: (value: string) => void
  onLogin: () => void
  loginQr: ApiState<LoginQrState>
  loginQrPhase: LoginQrPhase
  onRequestLoginQr: () => void
  onCheckLoginQr: () => void
  message: string
}) {
  const [loginMethod, setLoginMethod] = useState<'qr' | 'cookie'>('qr')
  const qrDisabled = loginQrPhase === 'expired' || loginQrPhase === 'error'
  const qrStatusText = loginQrPhase === 'checking'
    ? '正在检查扫码状态...'
    : loginQrPhase === 'expired'
      ? '二维码已失效，请刷新后重新扫码'
      : loginQrPhase === 'error'
        ? '扫码登录出错，请刷新二维码后重试'
        : loginQr.data
          ? '请使用 QQ 扫码确认登录'
          : ''

  return (
    <section className="login-card">
      <div className="brand-lockup login-brand">
        <div className="brand-mark">
          <img src="/public/logo.svg" alt="" />
        </div>
        <div>
          <h1>XMusic</h1>
          <span>连接你的 QQ 音乐收藏</span>
        </div>
      </div>
      <div className="login-tabs" role="tablist" aria-label="登录方式">
        <button
          className={loginMethod === 'qr' ? 'active' : ''}
          role="tab"
          aria-selected={loginMethod === 'qr'}
          onClick={() => setLoginMethod('qr')}
        >
          <LogIn size={16} />
          扫码登录
        </button>
        <button
          className={loginMethod === 'cookie' ? 'active' : ''}
          role="tab"
          aria-selected={loginMethod === 'cookie'}
          onClick={() => setLoginMethod('cookie')}
        >
          <KeyRound size={16} />
          Cookie 登录
        </button>
      </div>
      <div className="login-methods">
        {loginMethod === 'qr' ? (
          <section role="tabpanel">
            <h2>QQ 扫码登录</h2>
            {loginQr.data ? (
              <div className="qr-login large">
                <div className={`qr-code ${qrDisabled ? 'disabled' : ''}`}>
                  <img src={loginQr.data.img} alt="QQ 登录二维码" />
                </div>
                {qrStatusText ? <p className={`qr-status ${qrDisabled ? 'attention' : ''}`}>{qrStatusText}</p> : null}
                <div className="qr-actions">
                  <button onClick={onRequestLoginQr} disabled={loginQr.loading || account.loading}><RefreshCw size={16} />刷新二维码</button>
                  <button onClick={onCheckLoginQr} disabled={account.loading || qrDisabled || loginQrPhase === 'checking'}>
                    <RefreshCw size={16} className={loginQrPhase === 'checking' ? 'spin' : undefined} />检查扫码状态
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={onRequestLoginQr} disabled={loginQr.loading}><LogIn size={16} />获取登录二维码</button>
            )}
            <Status state={loginQr} />
          </section>
        ) : (
          <section role="tabpanel">
            <h2>备用登录</h2>
            <textarea value={cookieText} onChange={event => onCookieTextChange(event.target.value)} placeholder="粘贴 QQ 音乐 Cookie" />
            <button onClick={onLogin} disabled={account.loading || !cookieText.trim()}><KeyRound size={16} />保存 Cookie</button>
          </section>
        )}
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
        <h3>帐号</h3>
        <button className="ghost-button" onClick={onLogout}><LogOut size={16} />登出</button>
      </div>
      <div className="account-summary">
        {avatarUrl ? <img src={avatarUrl} alt="" /> : <div className="avatar-placeholder">{account.uin?.slice(-2) ?? 'QQ'}</div>}
        <dl className="account-facts">
          <div><dt>QQ 音乐</dt><dd>{account.uin}</dd></div>
          <div><dt>播放器帐号</dt><dd>{account.emby?.username ?? account.uin}</dd></div>
        </dl>
      </div>
    </section>
  )
}

function HomePanel({
  connection,
  ampcastUrl,
  onOpenConfig,
}: {
  connection: ConnectionInfo
  ampcastUrl: string
  onOpenConfig: () => void
}) {
  return (
    <div className="home-layout">
      <section className="hero-panel">
        <p className="eyebrow">XMusic</p>
        <h3>把音乐装进自己口袋</h3>
        <p>连接 QQ 音乐和 Emby，打通收藏、歌单、记录，让音乐跟着你走。</p>
        <div className="hero-actions">
          <a className="primary-link" href={ampcastUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} />打开播放器</a>
          <button className="secondary-button" onClick={onOpenConfig}><Settings size={16} />管理连接</button>
        </div>
      </section>
      <section className="benefit-grid">
        <BenefitCard icon={Music2} title="随身曲库" text="熟悉的歌，换个地方继续听。" />
        <BenefitCard icon={BadgeCheck} title="自己掌控" text="用自己的服务，连自己的播放器。" />
        <BenefitCard icon={Sparkles} title="少点折腾" text="同步收藏和记录，打开就听。" />
      </section>
      <section className="connect-panel">
        <div className="section-head">
          <h3>播放器连接</h3>
          <button className="secondary-button compact-button" onClick={onOpenConfig}><Settings size={15} />管理</button>
        </div>
        <div className="connection-copy-grid">
          <InfoCard icon={Link2} title="服务器地址" value={connection.server || '-'} copyValue={connection.server} />
          <InfoCard icon={UserRound} title="播放器帐号" value={connection.username || '-'} copyValue={connection.username} />
          <InfoCard icon={KeyRound} title="密码" value={maskedSecret(connection.password)} copyValue={connection.password} />
        </div>
      </section>
      <section className="connect-panel">
        <div className="section-head">
          <h3>推荐播放器</h3>
        </div>
        <div className="player-support-grid">
          {playerRecommendations.map(player => (
            <a className="player-card" href={player.name === 'ampcast' ? ampcastUrl : player.href} target="_blank" rel="noreferrer" key={player.name}>
              <span>{player.platform}</span>
              <strong>{player.name}</strong>
            </a>
          ))}
        </div>
      </section>
    </div>
  )
}

function PlayerPanel({ ampcastUrl }: { ampcastUrl: string }) {
  return (
    <div className="player-layout">
      <section className="ampcast-panel">
        <iframe title="ampcast" src={ampcastUrl} />
      </section>
    </div>
  )
}

function ConfigPanel({
  draft,
  embyConfig,
  connection,
  onChange,
  onSave,
  onRegeneratePassword,
  loading,
}: {
  draft: ConfigDraft
  embyConfig: ApiState<AccountEmbyConfig>
  connection: ConnectionInfo
  onChange: (value: ConfigDraft) => void
  onSave: () => void
  onRegeneratePassword: () => void
  loading: boolean
}) {
  const patch = (value: Partial<ConfigDraft>) => onChange({ ...draft, ...value })
  const [showPassword, setShowPassword] = useState(false)
  return (
    <div className="config-grid">
      <section>
        <h3>播放器连接</h3>
        <dl className="connection-list">
          <div>
            <dt>服务器地址</dt>
            <dd><span>{connection.server || '-'}</span><CopyButton value={connection.server} label="复制服务器地址" iconOnly /></dd>
          </div>
          <div>
            <dt>播放器帐号</dt>
            <dd><span>{connection.username || '-'}</span><CopyButton value={connection.username} label="复制播放器帐号" iconOnly /></dd>
          </div>
          <div>
            <dt>密码</dt>
            <dd>
              <span>{showPassword ? connection.password || '-' : maskedSecret(connection.password)}</span>
              <span className="inline-actions">
                <IconButton label={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword(value => !value)} disabled={!connection.password}>
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </IconButton>
                <CopyButton value={connection.password} label="复制密码" iconOnly />
                <IconButton label="重新生成密码" onClick={onRegeneratePassword} disabled={loading}><RefreshCw size={16} /></IconButton>
              </span>
            </dd>
          </div>
        </dl>
        <Status state={embyConfig} />
      </section>
      <section>
        <h3>QQ 音乐</h3>
        <label className="check-row">
          <input type="checkbox" checked={draft.qqEnabled} onChange={event => patch({ qqEnabled: event.target.checked })} />
          <span>启用 QQ 帐号能力</span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={draft.qqSyncFavorites} onChange={event => patch({ qqSyncFavorites: event.target.checked })} />
          <span>同步我的收藏</span>
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

function HealthPanel({ health }: { health: HealthStatus }) {
  const cacheEntries = Object.entries(health.resourceCache.byType)
  return (
    <div className="ops-layout">
      <section className={health.ok ? 'status-banner ok' : 'status-banner attention'}>
        <div>
          <span>{health.ok ? 'OK' : 'Needs Attention'}</span>
          <h3>{health.ok ? '核心依赖可用' : '需要处理运行问题'}</h3>
          <p>最后检查 {formatDateTime(health.checkedAt)}</p>
        </div>
      </section>

      <section className="metric-grid">
        <MetricCard icon={Database} label="曲库" value={String(health.database.tracks ?? 0)} detail={`${health.database.trackFiles ?? 0} 个文件 · ${health.database.playEvents ?? 0} 次播放`} tone={health.database.ok ? 'ok' : 'bad'} />
        <MetricCard icon={Workflow} label="任务" value={String(health.jobs.total)} detail={`${health.jobs.queued} 等待 · ${health.jobs.failed} 失败`} tone={health.jobs.failed ? 'bad' : health.jobs.queued ? 'warn' : 'ok'} />
        <MetricCard icon={PlayCircle} label="资源缓存" value={`${health.resourceCache.total}`} detail={formatBytes(health.resourceCache.totalBytes)} tone="ok" />
        <MetricCard icon={KeyRound} label="配置" value={health.config.missing.length ? '缺少配置' : '可用'} detail={health.config.missing.length ? health.config.missing.join(', ') : '音源已就绪'} tone={health.config.missing.length ? 'bad' : 'ok'} />
      </section>

      <section className="ops-grid">
        <article>
          <h3>资源缓存</h3>
          <div className="status-table">
            <div>
              <span>全部资源</span>
              <strong>{health.resourceCache.total}</strong>
              <small>{formatBytes(health.resourceCache.totalBytes)}</small>
            </div>
            {cacheEntries.length ? cacheEntries.map(([type, item]) => (
              <div key={type}>
                <span>{resourceLabel(type)}</span>
                <strong>{item.count}</strong>
                <small>{formatBytes(item.bytes)}</small>
              </div>
            )) : <p>暂无缓存</p>}
          </div>
        </article>

        <article>
          <h3>收藏同步</h3>
          <div className="status-table">
            <div>
              <span>已收藏</span>
              <strong>{health.favorites.favoriteCount}</strong>
              <small>当前帐号收藏</small>
            </div>
            <div>
              <span>等待同步</span>
              <strong>{health.favorites.pendingCount}</strong>
              <small>稍后会自动处理</small>
            </div>
            <div>
              <span>同步失败</span>
              <strong>{health.favorites.failedCount}</strong>
              <small>{health.favorites.failedCount ? '需要检查任务详情' : '无需处理'}</small>
            </div>
          </div>
        </article>
      </section>
    </div>
  )
}

function JobsPanel({ jobs }: { jobs: JobsResult }) {
  const [selectedJob, setSelectedJob] = useState<JobItem | null>(null)
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
        </div>
        {jobs.items.map(job => (
          <button className={`job-row ${selectedJob?.id === job.id ? 'active' : ''}`} key={job.id} onClick={() => setSelectedJob(job)}>
            <span>#{job.id}</span>
            <span>{job.type}</span>
            <span><StatusBadge status={job.status} /></span>
            <span>{job.attempts}</span>
            <span>{formatDateTime(job.updatedAt)}</span>
          </button>
        ))}
        {!jobs.items.length ? <p>暂无任务记录</p> : null}
      </section>
      {selectedJob ? <JobDetailDialog job={selectedJob} onClose={() => setSelectedJob(null)} /> : null}
    </div>
  )
}

function JobDetailDialog({ job, onClose }: { job: JobItem; onClose: () => void }) {
  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <section className="job-detail dialog-panel" role="dialog" aria-modal="true" aria-labelledby="job-detail-title" onClick={event => event.stopPropagation()}>
        <div className="section-head">
          <h3 id="job-detail-title">任务 #{job.id}</h3>
          <button className="secondary-button compact-button" onClick={onClose}>关闭</button>
        </div>
        <dl className="connection-list">
          <div><dt>类型</dt><dd><span>{job.type}</span></dd></div>
          <div><dt>状态</dt><dd><span>{job.status}</span></dd></div>
          <div><dt>尝试次数</dt><dd><span>{job.attempts}</span></dd></div>
          <div><dt>创建时间</dt><dd><span>{formatDateTime(job.createdAt)}</span></dd></div>
          <div><dt>更新时间</dt><dd><span>{formatDateTime(job.updatedAt)}</span></dd></div>
        </dl>
        {job.error ? <p className="status error">{job.error}</p> : null}
        <pre>{JSON.stringify(job.payload, null, 2)}</pre>
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

function BenefitCard({
  icon: Icon,
  title,
  text,
}: {
  icon: ComponentType<{ size?: number }>
  title: string
  text: string
}) {
  return (
    <article className="benefit-card">
      <Icon size={18} />
      <div>
        <h4>{title}</h4>
        <p>{text}</p>
      </div>
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
  if (view === 'home') return '连接你的音乐生活'
  if (view === 'player') return '打开播放器收听'
  if (view === 'config') return '管理播放器连接'
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

function resourceLabel(type: string): string {
  if (type === 'image') return '图片'
  if (type === 'audio') return '音频'
  if (type === 'lyrics') return '歌词'
  return type
}

function maskedSecret(value: string): string {
  return value ? '*'.repeat(Math.min(Math.max(value.length, 6), 12)) : '-'
}
