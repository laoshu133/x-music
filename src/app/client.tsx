'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import {
  Activity,
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
  PlayCircle,
  RefreshCw,
  Heart,
  Trash2,
  Settings,
  Smartphone,
  Workflow,
  UsersRound,
  UserRound,
} from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'

type View = 'home' | 'player' | 'config' | 'status' | 'users' | 'jobs'

const AMPCAST_OFFICIAL_URL = 'https://ampcast.app/'
const EMBEDDED_PLAYER_AUTO_INIT_PATH = '/@player/auto-init'

interface ApiState<T> {
  loading: boolean
  error: string
  data: T | null
}

const emptyState = <T,>(): ApiState<T> => ({ loading: false, error: '', data: null })

interface AccountState {
  loggedIn: boolean
  user?: { id: string; username: string; role: 'admin' | 'user'; status: 'active' | 'disabled' }
  username?: string
  qq?: { authorized: boolean; status: 'missing' | 'active' | 'expired'; uin?: string; nickname?: string; error?: string }
  systemError?: boolean
  isAdmin?: boolean
  hasEncryptedUin?: boolean
  hasQQMusicKey?: boolean
  accessTokenExpiresAt?: string
  actionable?: string
  emby?: {
    username?: string
    hasPassword?: boolean
    generatedPassword?: string
    userId?: string
    hasAccessToken?: boolean
  }
}

interface AccountRefreshResult {
  refreshed: boolean
  changed: boolean
  keyRefreshed?: boolean
  tokenRefreshed?: boolean
  refreshedAt: string
  hasQQMusicKey: boolean
  accessTokenExpiresAt?: string
  account?: AccountState
}

interface LoginQrState {
  img: string
  attemptId: string
}

type LoginQrPhase = 'idle' | 'active' | 'checking' | 'scanned' | 'expired' | 'error'

interface UserAvatarResult {
  source: 'tx'
  avatarUrl: string
  size: number
}

interface AdminConfig {
  lx: { sourceScriptUrl?: string }
  gateway: {
    accountMode?: string
  }
  player: {
    ampcastUrl: string
  }
  qq: { enabled: boolean; syncFavorites: boolean; syncPlaylists: boolean; syncPlayHistory: boolean }
}

interface HealthStatus {
  ok: boolean
  checkedAt: string
  account: {
    loggedIn: boolean
    qqUin?: string
    qqNickname?: string
    qqAuthState: 'active' | 'expired' | 'missing'
    qqAuthCheckedAt?: string
    qqAuthError?: string
    embyGatewayUsername?: string
    embyConfigured: boolean
    embyDsnConfigured?: boolean
    webdavConfigured: boolean
    proxyTimeoutMs?: number
  }
  database: { ok: boolean; tracks?: number; trackFiles?: number; playEvents?: number; error?: string }
  cache: Record<string, { path: string; exists: boolean; writable: boolean; isDirectory: boolean; entries: number; error?: string }>
  jobs: { byStatus: Record<string, number>; byType?: Record<string, Record<string, number>>; total: number; queued: number; running: number; completed: number; failed: number }
  favorites: { favoriteCount: number; pendingCount: number; failedCount: number }
  resourceCache: { total: number; totalBytes: number; byType: Record<string, { count: number; bytes: number }> }
  audioCache: {
    total: number
    totalBytes: number
    byQuality: Record<string, { total: number; bytes: number; byStatus: Record<string, number> }>
    byStatus: Record<string, number>
    lyrics: number
    covers: number
    ready: number
    tagging: number
    cachedRaw: number
    failed: number
    missing: number
  }
  sync: {
    jobs: Record<string, { total: number; queued: number; running: number; completed: number; failed: number }>
    recentFailures: Array<{ id: number; type: string; error: string; updatedAt: string }>
    webdav: { uploaded: number; skippedExisting: number }
  }
  config: { missing: string[]; lxMusicSourceScript: boolean }
  permissions?: { isAdmin: boolean }
}

interface FavoriteStatusSummary {
  qqTotal: number
  embyTotal: number
}

interface FavoriteStatusSyncResult extends FavoriteStatusSummary {
  changed: number
  skipped: number
  failed: number
  sync: {
    attempted: number
    synced: number
    failed: number
    skipped: number
    beforeEmbyTotal: number
    afterEmbyTotal: number
    errors: Array<{ songmid: string; error: string }>
  }
}

interface JobsResult {
  summary: HealthStatus['jobs']
  items: JobItem[]
}

interface UsersResult {
  items: UserItem[]
}

interface UserItem {
  userId: string
  username: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
  qqUin?: string
  qqNickname?: string
  embyUsername: string
  embyUserId?: string
  isAdmin: boolean
  playCount: number
  favoriteCount: number
  createdAt: string
  updatedAt: string
  lastLoginAt?: string
  lastLoginIp?: string
  lastActiveAt?: string
}

interface UserTrackItem {
  source: string
  songmid: string
  name: string
  singer: string
  albumName?: string
  quality?: string
  playedAt?: string
  favoriteUpdatedAt?: string
  syncState?: string
}

interface UserDetail {
  account: UserItem & {
    encryptedUin?: string
    hasQQMusicKey: boolean
    hasEmbyPassword: boolean
    hasEmbyAccessToken: boolean
  }
  qq: {
    authorized: boolean
    status: 'missing' | 'active' | 'expired'
    source?: string
    uin?: string
    hasEncryptedUin?: boolean
    hasQQMusicKey?: boolean
  }
  favorites: {
    source: 'qq' | 'local'
    total: number
    items: UserTrackItem[]
    page?: number
    limit?: number
    error?: string
  }
  recentPlays: UserTrackItem[]
}

type UserProfile = Pick<UserDetail, 'account' | 'qq'>
type UserFavorites = UserDetail['favorites']
type UserPlays = { page: number; limit: number; total: number; items: UserTrackItem[] }
type UserDetailTab = 'profile' | 'favorites' | 'plays'
const userDetailPageSize = 50

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
  qqSyncPlaylists: boolean
  qqSyncPlayHistory: boolean
}

interface AccountEmbyConfig {
  username: string
  password: string
  hasPassword: boolean
  dsn?: string
  maskedDsn?: string
  sourceWebdavDsn?: string
  hasSourceWebdavDsn?: boolean
  proxyTimeoutMs: number
  syncRecommended?: boolean
}

interface IncrementalEmbySyncResult {
  favorites: {
    attempted: number
    synced: number
    failed: number
    skipped: number
  }
  playlists: {
    attempted: number
    synced: number
    failed: number
    skipped: number
  }
}

interface ConnectionInfo {
  server: string
  username: string
  password: string
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly actionable?: string,
    readonly payload?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

const playerRecommendations = [
  { name: 'ampcast', platform: 'Web / Desktop', href: 'https://ampcast.app/' },
  { name: '箭头音乐', platform: 'iOS / Android', href: 'https://cn.amcfy.com/' },
  { name: '音流', platform: 'iOS / Android / Desktop', href: 'https://music.aqzscn.cn/' },
  { name: 'VutronMusic', platform: 'Windows / macOS / Linux', href: 'https://github.com/stark81/VutronMusic' },
]

const fetchJson = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init)
  const body = await response.json().catch(() => undefined) as unknown
  if (!response.ok) {
    const record = body && typeof body === 'object' ? body as Record<string, unknown> : undefined
    const message = record && 'error' in record
      ? String((body as { error: unknown }).error)
      : `Request failed: ${response.status}`
    throw new ApiError(
      message,
      response.status,
      typeof record?.code === 'string' ? record.code : undefined,
      typeof record?.actionable === 'string' ? record.actionable : undefined,
      record?.payload,
    )
  }
  return body as T
}

const viewMeta: Record<View, { label: string; icon: ComponentType<{ size?: number }> }> = {
  home: { label: '首页', icon: Home },
  player: { label: '播放器', icon: MonitorPlay },
  config: { label: '设置', icon: Settings },
  status: { label: '状态', icon: Activity },
  users: { label: '用户', icon: UsersRound },
  jobs: { label: '任务', icon: Workflow },
}

const views = Object.keys(viewMeta) as View[]
const sidebarCollapsedStorageKey = 'xmusic.sidebarCollapsed'

function parseView(value: string | null): View {
  return value && views.includes(value as View) ? value as View : 'home'
}

function initialSidebarCollapsed() {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(sidebarCollapsedStorageKey) === '1'
  } catch {
    return false
  }
}

function persistSidebarCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(sidebarCollapsedStorageKey, collapsed ? '1' : '0')
  } catch {
    // Some mobile WebViews disable localStorage. Sidebar state is only a preference.
  }
}

export default function MusicClient({ initialAccount }: { initialAccount: AccountState }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const routeView = parseView(searchParams.get('view'))
  const [view, setView] = useState<View>(() => isViewAllowed(routeView, initialAccount) ? routeView : 'home')
  const [cookieText, setCookieText] = useState('')
  const [systemUsername, setSystemUsername] = useState('')
  const [systemPassword, setSystemPassword] = useState('')
  const [systemAuthMode, setSystemAuthMode] = useState<'login' | 'register'>('login')
  const [mobileAuthUrl, setMobileAuthUrl] = useState('')
  const [account, setAccount] = useState<ApiState<AccountState>>({ loading: false, error: '', data: initialAccount })
  const [accountRefresh, setAccountRefresh] = useState<ApiState<AccountRefreshResult>>(emptyState)
  const [loginQr, setLoginQr] = useState<ApiState<LoginQrState>>(emptyState)
  const [loginQrPhase, setLoginQrPhase] = useState<LoginQrPhase>('idle')
  const [avatar, setAvatar] = useState<ApiState<UserAvatarResult>>(emptyState)
  const [accountEmbyConfig, setAccountEmbyConfig] = useState<ApiState<AccountEmbyConfig>>(emptyState)
  const [adminConfig, setAdminConfig] = useState<ApiState<AdminConfig>>(emptyState)
  const [health, setHealth] = useState<ApiState<HealthStatus>>(emptyState)
  const [favoriteStatus, setFavoriteStatus] = useState<ApiState<FavoriteStatusSummary>>(emptyState)
  const [jobs, setJobs] = useState<ApiState<JobsResult>>(emptyState)
  const [users, setUsers] = useState<ApiState<UsersResult>>(emptyState)
  const [message, setMessage] = useState(initialAccount.systemError ? initialAccount.actionable ?? '系统出错，请稍后重试。' : '')
  const [browserOrigin, setBrowserOrigin] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed)
  const [embyPasswordDraft, setEmbyPasswordDraft] = useState('')
  const [embyDsnDraft, setEmbyDsnDraft] = useState('')
  const [embyWebdavDraft, setEmbyWebdavDraft] = useState('')
  const [embyProxyTimeoutDraft, setEmbyProxyTimeoutDraft] = useState('30000')
  const [embyIncrementalSync, setEmbyIncrementalSync] = useState<ApiState<IncrementalEmbySyncResult>>(emptyState)
  const [showEmbySyncPrompt, setShowEmbySyncPrompt] = useState(false)
  const loginQrCheckInFlightRef = useRef(false)
  const [configDraft, setConfigDraft] = useState<ConfigDraft>({
    qqEnabled: true,
    qqSyncFavorites: true,
    qqSyncPlaylists: true,
    qqSyncPlayHistory: true,
  })

  const embyUrl = browserOrigin
  const mobileAuthorizeUrl = '/auth/mobile/start'
  const ampcastOfficialUrl = useMemo(() => new URL(AMPCAST_OFFICIAL_URL).toString(), [])
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

  const loadAccount = async () => {
    setAccount(current => ({ loading: true, error: '', data: current.data }))
    try {
      setAccount({ loading: false, error: '', data: await fetchJson<AccountState>('/api/account') })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'QQ_AUTH_EXPIRED') {
        const actionable = error.actionable ?? '重新完成 QQ 授权登录后再继续使用 XMusic。'
        setMessage(actionable)
        setAccount({
          loading: false,
          error: '',
          data: {
            loggedIn: false,
            actionable,
          },
        })
        return
      }
      setAccount({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        data: { loggedIn: false },
      })
    }
  }
  const loadAccountEmbyConfig = () => run(s => setAccountEmbyConfig(s), async () => {
    const data = await fetchJson<AccountEmbyConfig>('/api/account/emby')
    setEmbyPasswordDraft(data.password)
    setEmbyDsnDraft(data.dsn ?? data.maskedDsn ?? '')
    setEmbyWebdavDraft(data.sourceWebdavDsn ?? '')
    setEmbyProxyTimeoutDraft(String(data.proxyTimeoutMs ?? 30000))
    return data
  })
  const loadHealth = () => run(s => setHealth(s), async () => {
    const response = await fetch('/api/health')
    const body = await response.json().catch(() => undefined) as HealthStatus | undefined
    if (!body) throw new Error(`Request failed: ${response.status}`)
    return body
  })
  const loadFavoriteStatus = () => run(s => setFavoriteStatus(s), () => fetchJson<FavoriteStatusSummary>('/api/favorites/status'))
  const syncFavoriteStatus = async () => {
    setMessage('')
    setFavoriteStatus({ loading: true, error: '', data: favoriteStatus.data })
    try {
      const result = await fetchJson<FavoriteStatusSyncResult>('/api/favorites/status', { method: 'POST' })
      setFavoriteStatus({ loading: false, error: '', data: { qqTotal: result.qqTotal, embyTotal: result.embyTotal } })
      setMessage(`同步收藏完成：新增 ${result.changed} 首；QQ 源收藏 ${result.qqTotal} 首，Emby 源收藏 ${result.embyTotal} 首`)
      loadHealth()
    } catch (error) {
      setFavoriteStatus({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        data: favoriteStatus.data,
      })
    }
  }
  const loadJobs = () => run(s => setJobs(s), () => fetchJson<JobsResult>('/api/jobs?limit=100'))
  const clearJobs = async (status: 'failed' | 'completed') => {
    setMessage('')
    setJobs({ loading: true, error: '', data: null })
    try {
      setJobs({
        loading: false,
        error: '',
        data: await fetchJson<JobsResult>(`/api/jobs?status=${status}`, { method: 'DELETE' }),
      })
      setMessage(status === 'failed' ? '已清空失败任务' : '已清空完成任务')
    } catch (error) {
      setJobs({ loading: false, error: error instanceof Error ? error.message : String(error), data: null })
    }
  }
  const loadUsers = () => run(s => setUsers(s), () => fetchJson<UsersResult>('/api/admin/users'))
  const loadAdminConfig = () => run(s => setAdminConfig(s), async () => {
    const data = await fetchJson<AdminConfig>('/api/admin/config')
    setConfigDraft({
      qqEnabled: data.qq.enabled,
      qqSyncFavorites: data.qq.syncFavorites,
      qqSyncPlaylists: data.qq.syncPlaylists,
      qqSyncPlayHistory: data.qq.syncPlayHistory,
    })
    return data
  })

  const login = async () => {
    setMessage('')
    setAccount(current => ({ loading: true, error: '', data: current.data }))
    try {
      const result = await fetchJson<AccountState>('/api/account/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cookie: cookieText, persist: true }),
      })
      setAccount({ loading: false, error: '', data: result })
      setCookieText('')
      await loadAdminConfig()
      await loadAccountEmbyConfig()
    } catch (error) {
      setAccount(current => ({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        data: current.data,
      }))
    }
  }

  const authenticateSystemAccount = async () => {
    setMessage('')
    const path = systemAuthMode === 'register' ? '/api/auth/register' : '/api/auth/login'
    await run(s => setAccount(s), () => fetchJson<AccountState>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: systemUsername, password: systemPassword }),
    }))
    setSystemPassword('')
  }

  const completeMobileAuthLogin = async () => {
    const value = mobileAuthUrl.trim()
    if (!value) return
    setMessage('')
    setAccount({ loading: true, error: '', data: account.data })
    try {
      const result = await fetchJson<{ isOk: true; message: string; account: AccountState }>('/api/account/mobile/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: value }),
      })
      setMobileAuthUrl('')
      setMessage(result.message)
      setAccount({ loading: false, error: '', data: result.account })
      await loadAdminConfig()
      await loadAccountEmbyConfig()
    } catch (error) {
      setAccount(current => ({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        data: current.data,
      }))
    }
  }

  const requestLoginQr = () => {
    setMessage('')
    loginQrCheckInFlightRef.current = false
    setLoginQrPhase('idle')
    run(s => setLoginQr(s), () => fetchJson<LoginQrState>('/api/account/qr'))
  }

  const checkLoginQr = async () => {
    const qr = loginQr.data
    if (!qr) return
    if (loginQrCheckInFlightRef.current) return
    loginQrCheckInFlightRef.current = true
    setLoginQrPhase('checking')
    setMessage('')
    try {
      const result = await fetchJson<
      | { isOk: false; refresh: boolean; status?: 'pending' | 'scanned' | 'expired'; message: string }
      | { isOk: true; message: string; account: AccountState }
    >('/api/account/qr/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: qr.attemptId }),
    })

      if (!result.isOk) {
        setLoginQrPhase(result.refresh || result.status === 'expired' ? 'expired' : result.status === 'scanned' ? 'scanned' : 'active')
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
    } finally {
      loginQrCheckInFlightRef.current = false
    }
  }

  const logout = async () => {
    setMessage('')
    await run(s => setAccount(s), async () => {
      await fetchJson<{ loggedIn: false }>('/api/account', { method: 'DELETE' })
      return { loggedIn: false }
    })
  }

  const refreshQQAuthorization = async () => {
    setMessage('')
    setAccountRefresh({ loading: true, error: '', data: accountRefresh.data })
    try {
      const result = await fetchJson<AccountRefreshResult>('/api/account/refresh', { method: 'POST' })
      setAccountRefresh({ loading: false, error: '', data: result })
      if (result.account) setAccount({ loading: false, error: '', data: result.account })
      setMessage('QQ 授权已刷新')
    } catch (error) {
      setAccountRefresh({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        data: accountRefresh.data,
      })
    }
  }

  const openView = (next: View) => {
    setMessage('')
    setView(next)
    router.push(next === 'home' ? '/' : `/?view=${next}`)
    loadViewData(next)
  }

  const loadViewData = (next: View) => {
    if (!isViewAllowed(next, account.data)) return
    if (!account.data?.qq?.authorized && next === 'home') return
    if (next === 'home' || next === 'player' || next === 'config') loadAdminConfig()
    if (next === 'home' || next === 'player' || next === 'config') loadAccountEmbyConfig()
    if (next === 'status') {
      loadHealth()
      loadFavoriteStatus()
    }
    if (next === 'users' && account.data?.isAdmin) loadUsers()
    if (next === 'jobs' && account.data?.isAdmin) loadJobs()
  }

  const saveAdminConfig = async () => {
    setMessage('')
    const password = embyPasswordDraft.trim()
    if (!password) {
      setMessage('请输入播放器密码')
      return
    }
    const payload: Record<string, unknown> = {
      qqEnabled: configDraft.qqEnabled,
      qqSyncFavorites: configDraft.qqSyncFavorites,
      qqSyncPlaylists: configDraft.qqSyncPlaylists,
      qqSyncPlayHistory: configDraft.qqSyncPlayHistory,
    }
    await run(s => setAdminConfig(s), () => fetchJson<AdminConfig>('/api/admin/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }))
    await run(s => setAccountEmbyConfig(s), async () => {
      const hadUpstream = Boolean(accountEmbyConfig.data?.dsn)
      const data = await fetchJson<AccountEmbyConfig>('/api/account/emby', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          password,
          dsn: embyDsnDraft,
          sourceWebdavDsn: embyWebdavDraft,
          proxyTimeoutMs: Number(embyProxyTimeoutDraft) || 30000,
        }),
      })
      setEmbyPasswordDraft(data.password)
      setEmbyDsnDraft(data.dsn ?? data.maskedDsn ?? '')
      setEmbyWebdavDraft(data.sourceWebdavDsn ?? '')
      setEmbyProxyTimeoutDraft(String(data.proxyTimeoutMs ?? 30000))
      if (data.syncRecommended || (!hadUpstream && data.dsn)) setShowEmbySyncPrompt(true)
      return data
    })
    setMessage('配置已保存')
  }

  const syncEmbyIncremental = async () => {
    setMessage('')
    setEmbyIncrementalSync({ loading: true, error: '', data: embyIncrementalSync.data })
    try {
      const result = await fetchJson<IncrementalEmbySyncResult>('/api/account/emby/sync', { method: 'POST' })
      setEmbyIncrementalSync({ loading: false, error: '', data: result })
      setShowEmbySyncPrompt(false)
      setMessage(`同步至 Emby 完成：收藏 ${result.favorites.synced}/${result.favorites.attempted}，歌单 ${result.playlists.synced}/${result.playlists.attempted}`)
      loadHealth()
    } catch (error) {
      setEmbyIncrementalSync({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        data: embyIncrementalSync.data,
      })
    }
  }

  useEffect(() => {
    setBrowserOrigin(window.location.origin)
    void loadAccount()
  }, [])

  useEffect(() => {
    persistSidebarCollapsed(sidebarCollapsed)
  }, [sidebarCollapsed])

  useEffect(() => {
    if (account.data?.loggedIn && !isViewAllowed(routeView, account.data)) {
      setView('home')
      if (routeView !== 'home') router.replace('/')
      return
    }
    setView(routeView)
    if (account.data?.loggedIn && isViewAllowed(routeView, account.data)) loadViewData(routeView)
  }, [routeView, account.data?.loggedIn, account.data?.qq?.authorized])

  useEffect(() => {
    if (!account.data?.loggedIn) return
    if (!isViewAllowed(view, account.data)) openView('home')
  }, [account.data?.loggedIn, account.data?.qq?.authorized, account.data?.isAdmin, view])

  useEffect(() => {
    if (account.data?.loggedIn && account.data.qq?.authorized) {
      void loadAccountEmbyConfig()
    }
  }, [account.data?.loggedIn, account.data?.qq?.authorized])

  useEffect(() => {
    if (!account.data?.loggedIn || !account.data.qq?.uin) {
      setAvatar(emptyState())
      return
    }
    void run(s => setAvatar(s), () => fetchJson<UserAvatarResult>('/api/user/avatar?size=100'))
  }, [account.data?.loggedIn, account.data?.qq?.uin])

  useEffect(() => {
    if (loginQr.data && loginQrPhase === 'idle') setLoginQrPhase('active')
  }, [loginQr.data, loginQrPhase])

  useEffect(() => {
    const shouldPollQr = loginQrPhase === 'active' || loginQrPhase === 'scanned'
    if (!loginQr.data || !shouldPollQr || account.data?.qq?.authorized) return

    const timer = window.setInterval(() => {
      void checkLoginQr()
    }, 2500)

    return () => window.clearInterval(timer)
  }, [loginQr.data, loginQrPhase, account.data?.qq?.authorized])

  if (account.loading && !account.data) {
    return (
      <main className="login-screen">
        <div className="login-card compact loading-card">
          <div className="loading-mark"><RefreshCw className="spin" size={20} /></div>
          <p>正在检查登录状态...</p>
        </div>
      </main>
    )
  }

  if (!account.data?.loggedIn) {
    return (
      <main className="login-screen">
        <SystemLoginPage
          account={account}
          username={systemUsername}
          password={systemPassword}
          mode={systemAuthMode}
          onUsernameChange={setSystemUsername}
          onPasswordChange={setSystemPassword}
          onModeChange={setSystemAuthMode}
          onSubmit={authenticateSystemAccount}
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
          <div className="brand-copy">
            <h1>XMusic</h1>
            <span>把音乐装进自己口袋</span>
          </div>
          <button className="collapse-button" onClick={() => setSidebarCollapsed(value => !value)} aria-label={sidebarCollapsed ? '展开导航' : '收起导航'} title={sidebarCollapsed ? '展开导航' : '收起导航'}>
            {sidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </div>
        <nav className="tabs" aria-label="主导航">
          {views.filter(key => isViewVisible(key, account.data)).map(key => {
            const Icon = viewMeta[key].icon
            const available = isViewAllowed(key, account.data)
            return (
              <button
                key={key}
                className={view === key ? 'active' : ''}
                onClick={() => openView(key)}
                disabled={!available}
                title={available ? undefined : '绑定 QQ 音乐后可用'}
              >
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
              <a className="secondary-button compact-button" href={EMBEDDED_PLAYER_AUTO_INIT_PATH} target="_blank" rel="noreferrer"><ExternalLink size={15} />新窗口打开</a>
            ) : null}
          </header>
        )}

        {message ? <p className="toast-message">{message}</p> : null}

        {view === 'home' && (
          <section className="workspace">
            {account.data.qq?.authorized ? (
              <>
                <Status state={adminConfig} />
                <HomePanel
                  account={account.data}
                  connection={connectionInfo}
                  playerPath={EMBEDDED_PLAYER_AUTO_INIT_PATH}
                  ampcastOfficialUrl={ampcastOfficialUrl}
                  accountRefresh={accountRefresh}
                  onOpenConfig={() => openView('config')}
                  onRefreshQQAuthorization={refreshQQAuthorization}
                />
              </>
            ) : (
              <QQAuthorizationPanel
                account={account}
                cookieText={cookieText}
                mobileAuthorizeUrl={mobileAuthorizeUrl}
                mobileAuthUrl={mobileAuthUrl}
                onCookieTextChange={setCookieText}
                onMobileAuthUrlChange={setMobileAuthUrl}
                onLogin={login}
                onCompleteMobileAuth={completeMobileAuthLogin}
                loginQr={loginQr}
                loginQrPhase={loginQrPhase}
                onRequestLoginQr={requestLoginQr}
              />
            )}
          </section>
        )}

        {view === 'player' && (
          <section className="workspace">
            <Status state={adminConfig} />
            <PlayerPanel playerPath={EMBEDDED_PLAYER_AUTO_INIT_PATH} />
          </section>
        )}

        {view === 'config' && (
          <section className="workspace">
            <div className="view-actions">
              <IconButton label="刷新" onClick={loadAdminConfig} disabled={adminConfig.loading}><RefreshCw size={16} /></IconButton>
            </div>
            <Status state={adminConfig} />
              <ConfigPanel
                draft={configDraft}
                embyConfig={accountEmbyConfig}
                connection={connectionInfo}
                passwordDraft={embyPasswordDraft}
                embyDsnDraft={embyDsnDraft}
                embyWebdavDraft={embyWebdavDraft}
                embyProxyTimeoutDraft={embyProxyTimeoutDraft}
                incrementalSync={embyIncrementalSync}
                showSyncPrompt={showEmbySyncPrompt}
                onChange={setConfigDraft}
                onPasswordChange={setEmbyPasswordDraft}
                onEmbyDsnChange={setEmbyDsnDraft}
                onEmbyWebdavChange={setEmbyWebdavDraft}
                onEmbyProxyTimeoutChange={setEmbyProxyTimeoutDraft}
                onSave={saveAdminConfig}
                onIncrementalSync={syncEmbyIncremental}
                onDismissSyncPrompt={() => setShowEmbySyncPrompt(false)}
                loading={adminConfig.loading || accountEmbyConfig.loading}
              />
          </section>
        )}

        {view === 'status' && (
          <section className="workspace">
            <div className="view-actions">
              <IconButton label="刷新" onClick={() => { loadHealth(); loadFavoriteStatus() }} disabled={health.loading || favoriteStatus.loading}><RefreshCw size={16} /></IconButton>
            </div>
            <Status state={health} />
            {health.data ? (
              <HealthPanel
                health={health.data}
                favoriteStatus={favoriteStatus}
                isAdmin={Boolean(account.data?.isAdmin)}
                onSyncFavorites={syncFavoriteStatus}
                onOpenConfig={() => openView('config')}
                onOpenJobs={() => openView('jobs')}
              />
            ) : null}
          </section>
        )}

        {view === 'jobs' && (
          <section className="workspace">
            <div className="view-actions">
              <div className="toolbar">
                <button className="secondary-button compact-button" onClick={() => clearJobs('failed')} disabled={jobs.loading || !jobs.data?.summary.failed}>
                  <Trash2 size={15} />清空已失败
                </button>
                <button className="secondary-button compact-button" onClick={() => clearJobs('completed')} disabled={jobs.loading || !jobs.data?.summary.completed}>
                  <Trash2 size={15} />清空已完成
                </button>
                <IconButton label="刷新" onClick={loadJobs} disabled={jobs.loading}><RefreshCw size={16} /></IconButton>
              </div>
            </div>
            <Status state={jobs} />
            {jobs.data ? <JobsPanel jobs={jobs.data} /> : null}
          </section>
        )}

        {view === 'users' && (
          <section className="workspace">
            <div className="view-actions">
              <IconButton label="刷新" onClick={loadUsers} disabled={users.loading}><RefreshCw size={16} /></IconButton>
            </div>
            <Status state={users} />
            {users.data ? <UsersPanel users={users.data} /> : null}
          </section>
        )}
      </section>
    </main>
  )
}

function isViewAllowed(view: View, account?: AccountState | null): boolean {
  if (!isViewVisible(view, account)) return false
  if (view === 'users' || view === 'jobs') return Boolean(account?.isAdmin)
  if (view === 'home') return true
  return Boolean(account?.qq?.authorized)
}

function isViewVisible(view: View, account?: AccountState | null): boolean {
  if (view === 'users' || view === 'jobs') return Boolean(account?.isAdmin)
  return true
}

function SystemLoginPage({ account, username, password, mode, onUsernameChange, onPasswordChange, onModeChange, onSubmit, message }: {
  account: ApiState<AccountState>
  username: string
  password: string
  mode: 'login' | 'register'
  onUsernameChange: (value: string) => void
  onPasswordChange: (value: string) => void
  onModeChange: (value: 'login' | 'register') => void
  onSubmit: () => void
  message: string
}) {
  const [showPassword, setShowPassword] = useState(false)

  return (
    <section className="login-card system-login-card">
      <div className="brand-lockup login-brand">
        <div className="brand-mark"><img src="/public/logo.svg" alt="" /></div>
        <div><h1>XMusic</h1><span>把音乐装进自己口袋</span></div>
      </div>
      <div className="login-tabs" role="tablist" aria-label="帐号操作">
        <button type="button" className={mode === 'login' ? 'active' : ''} aria-selected={mode === 'login'} onClick={() => onModeChange('login')}><LogIn size={16} /><span>登录</span></button>
        <button type="button" className={mode === 'register' ? 'active' : ''} aria-selected={mode === 'register'} onClick={() => onModeChange('register')}><UserRound size={16} /><span>注册</span></button>
      </div>
      <form className="system-auth-form" onSubmit={(event) => { event.preventDefault(); onSubmit() }}>
        <label htmlFor="system-username">用户名</label>
        <div className="auth-input-shell">
          <UserRound size={17} />
          <input id="system-username" autoComplete="username" value={username} onChange={event => onUsernameChange(event.target.value)} placeholder="请输入用户名" />
        </div>
        <label htmlFor="system-password">密码</label>
        <div className="auth-input-shell">
          <KeyRound size={17} />
          <input id="system-password" type={showPassword ? 'text' : 'password'} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} value={password} onChange={event => onPasswordChange(event.target.value)} placeholder="请输入密码" />
          <button type="button" className="auth-input-action" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? '隐藏密码' : '显示密码'} title={showPassword ? '隐藏密码' : '显示密码'}>
            {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
        </div>
        <button className="auth-submit" type="submit" disabled={account.loading || !username.trim() || password.length < 8}>
          {account.loading ? <RefreshCw className="spin" size={16} /> : mode === 'register' ? <UserRound size={16} /> : <LogIn size={16} />}
          {mode === 'register' ? '创建帐号' : '登录'}
        </button>
      </form>
      {message ? <p className="status notice auth-status">{message}</p> : null}
      <div className="auth-status"><Status state={account} /></div>
    </section>
  )
}

function QQAuthorizationPanel({
  account,
  cookieText,
  mobileAuthorizeUrl,
  mobileAuthUrl,
  onCookieTextChange,
  onMobileAuthUrlChange,
  onLogin,
  onCompleteMobileAuth,
  loginQr,
  loginQrPhase,
  onRequestLoginQr,
}: {
  account: ApiState<AccountState>
  cookieText: string
  mobileAuthorizeUrl: string
  mobileAuthUrl: string
  onCookieTextChange: (value: string) => void
  onMobileAuthUrlChange: (value: string) => void
  onLogin: () => void
  onCompleteMobileAuth: () => void
  loginQr: ApiState<LoginQrState>
  loginQrPhase: LoginQrPhase
  onRequestLoginQr: () => void
}) {
  const [loginMethod, setLoginMethod] = useState<'qr' | 'mobile' | 'cookie'>('qr')
  const qrDisabled = loginQrPhase === 'expired' || loginQrPhase === 'error'
  const qrStatusText = loginQrPhase === 'checking'
    ? '检查中'
    : loginQrPhase === 'scanned'
      ? '待确认'
    : loginQrPhase === 'expired'
      ? '已失效'
      : loginQrPhase === 'error'
        ? '授权异常'
        : loginQr.data
          ? '等待扫码'
          : ''

  useEffect(() => {
    if (isMobileLoginDevice()) setLoginMethod('mobile')
  }, [])

  return (
    <section className="qq-auth-panel">
      <header className="qq-auth-heading">
        <h2>绑定 QQ 音乐</h2>
        <p>绑定后即可使用播放器，并同步你的收藏、歌单和播放记录。</p>
      </header>
      <div className="login-tabs" role="tablist" aria-label="QQ 绑定方式">
        <button
          type="button"
          className={loginMethod === 'qr' ? 'active' : ''}
          role="tab"
          aria-selected={loginMethod === 'qr'}
          title="扫码授权"
          aria-label="扫码授权"
          onClick={() => setLoginMethod('qr')}
        >
          <LogIn size={16} />
          <span>扫码授权</span>
        </button>
        <button
          type="button"
          className={loginMethod === 'mobile' ? 'active' : ''}
          role="tab"
          aria-selected={loginMethod === 'mobile'}
          title="手机授权"
          aria-label="手机授权"
          onClick={() => setLoginMethod('mobile')}
        >
          <Smartphone size={16} />
          <span>手机授权</span>
        </button>
        <button
          type="button"
          className={loginMethod === 'cookie' ? 'active' : ''}
          role="tab"
          aria-selected={loginMethod === 'cookie'}
          title="Cookie"
          aria-label="Cookie"
          onClick={() => setLoginMethod('cookie')}
        >
          <KeyRound size={16} />
          <span>Cookie</span>
        </button>
      </div>
      <div className="login-methods">
        {loginMethod === 'qr' ? (
          <section role="tabpanel">
            {loginQr.data ? (
              <div className="qr-login large">
                <div className="qr-visual">
                  <div className={`qr-code ${qrDisabled ? 'disabled' : ''}`}>
                    <img src={loginQr.data.img} alt="QQ 授权二维码" />
                  </div>
                </div>
                <div className="qr-copy">
                  {qrStatusText ? <p className={`qr-status ${qrDisabled ? 'attention' : ''}`}>{qrStatusText}</p> : null}
                  <p className="qr-hint">打开手机 QQ 扫描二维码</p>
                  <div className="qr-actions">
                    <button onClick={onRequestLoginQr} disabled={loginQr.loading || account.loading}><RefreshCw size={16} />刷新二维码</button>
                  </div>
                </div>
              </div>
            ) : (
              <button onClick={onRequestLoginQr} disabled={loginQr.loading}><LogIn size={16} />获取二维码</button>
            )}
            <Status state={loginQr} />
          </section>
        ) : loginMethod === 'mobile' ? (
          <section role="tabpanel">
            <p className="login-help">授权后如果没有自动返回，请粘贴当前页面地址。</p>
            <div className="mobile-auth-actions">
              <a className="primary-link" href={mobileAuthorizeUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={16} />
                打开 QQ 授权
              </a>
            </div>
            <form
              className="mobile-auth-form"
              onSubmit={(event) => {
                event.preventDefault()
                onCompleteMobileAuth()
              }}
            >
              <label htmlFor="login-mobile-auth-url">授权页面地址</label>
              <textarea
                id="login-mobile-auth-url"
                name="url"
                value={mobileAuthUrl}
                onChange={event => onMobileAuthUrlChange(event.target.value)}
                placeholder="粘贴授权后的页面地址"
              />
              <button type="submit" disabled={account.loading || !mobileAuthUrl.trim()}><KeyRound size={16} />完成绑定</button>
            </form>
          </section>
        ) : (
          <section role="tabpanel">
            <textarea value={cookieText} onChange={event => onCookieTextChange(event.target.value)} placeholder="粘贴 QQ 音乐 Cookie" />
            <button onClick={onLogin} disabled={account.loading || !cookieText.trim()}><KeyRound size={16} />保存 Cookie</button>
          </section>
        )}
      </div>
      <Status state={account} />
    </section>
  )
}

function isMobileLoginDevice(): boolean {
  if (typeof window === 'undefined') return false
  const userAgent = window.navigator.userAgent
  const mobileUserAgent = /Android|iPhone|iPod|Mobile|Windows Phone/i.test(userAgent)
  const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const narrowViewport = window.matchMedia?.('(max-width: 640px)').matches ?? window.innerWidth <= 640
  return mobileUserAgent || (coarsePointer && narrowViewport)
}

function AccountSummary({ account, avatarUrl, onLogout }: { account: AccountState; avatarUrl?: string; onLogout: () => void }) {
  const displayName = account.qq?.nickname ?? account.username ?? '-'
  const [menuOpen, setMenuOpen] = useState(false)
  const panelRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!menuOpen) return
    const closeMenu = (event: MouseEvent) => {
      if (panelRef.current?.contains(event.target as Node)) return
      setMenuOpen(false)
    }
    window.addEventListener('mousedown', closeMenu)
    return () => window.removeEventListener('mousedown', closeMenu)
  }, [menuOpen])

  return (
    <section className="account-panel" ref={panelRef}>
      <div className="section-head">
        <h3>帐号</h3>
        <button className="ghost-button" onClick={onLogout}><LogOut size={16} />登出</button>
      </div>
      <div className="account-summary">
        <button className="account-avatar-button" onClick={() => setMenuOpen(value => !value)} aria-label="帐号菜单" aria-expanded={menuOpen}>
          {avatarUrl ? <img src={avatarUrl} alt="" /> : <span className="avatar-placeholder">{account.username?.slice(0, 2).toUpperCase() ?? 'XM'}</span>}
        </button>
        <dl className="account-facts">
          <div><dt>用户名</dt><dd>{account.username ?? '-'}</dd></div>
          <div><dt>QQ</dt><dd>{account.qq?.uin ?? '-'}</dd></div>
        </dl>
      </div>
      {menuOpen ? (
        <div className="account-popover" role="menu">
          <dl>
            <div><dt>QQ 昵称</dt><dd>{displayName}</dd></div>
            <div><dt>QQ</dt><dd>{account.qq?.uin ?? '-'}</dd></div>
          </dl>
          <button className="ghost-button" onClick={onLogout} role="menuitem"><LogOut size={16} />登出</button>
        </div>
      ) : null}
    </section>
  )
}

function HomePanel({
  account,
  connection,
  playerPath,
  ampcastOfficialUrl,
  accountRefresh,
  onOpenConfig,
  onRefreshQQAuthorization,
}: {
  account: AccountState
  connection: ConnectionInfo
  playerPath: string
  ampcastOfficialUrl: string
  accountRefresh: ApiState<AccountRefreshResult>
  onOpenConfig: () => void
  onRefreshQQAuthorization: () => void
}) {
  const accessTokenExpiresAt = accountRefresh.data?.accessTokenExpiresAt
    ?? accountRefresh.data?.account?.accessTokenExpiresAt
    ?? account.accessTokenExpiresAt

  return (
    <div className="home-layout">
      <section className="home-overview">
        <h2>音乐服务</h2>
        <div className="toolbar">
          <a className="primary-link" href={playerPath} target="_blank" rel="noreferrer"><ExternalLink size={16} />打开播放器</a>
          <button className="secondary-button" onClick={onOpenConfig}><Settings size={16} />设置</button>
        </div>
      </section>
      <section className="connect-panel">
        <div className="section-head">
          <h3>播放器</h3>
          <button className="secondary-button compact-button" onClick={onOpenConfig}><Settings size={15} />管理</button>
        </div>
        <div className="connection-copy-grid">
          <InfoCard icon={Link2} title="地址" value={connection.server || '-'} copyValue={connection.server} />
          <InfoCard icon={UserRound} title="用户名" value={connection.username || '-'} copyValue={connection.username} />
          <InfoCard icon={KeyRound} title="密码" value={maskedSecret(connection.password)} copyValue={connection.password} />
        </div>
      </section>
      <section className="connect-panel">
        <div className="section-head">
          <h3>QQ 授权</h3>
          <button className="secondary-button compact-button auth-refresh-button" onClick={onRefreshQQAuthorization} disabled={accountRefresh.loading}>
            <RefreshCw className={accountRefresh.loading ? 'spin' : undefined} size={15} />
            刷新授权
          </button>
        </div>
        <div className="status-table">
          <div>
            <span>上次刷新</span>
            <strong>{accountRefresh.data?.refreshedAt ? formatDateTime(accountRefresh.data.refreshedAt) : '-'}</strong>
          </div>
          <div>
            <span>有效期</span>
            <strong>{accessTokenExpiresAt ? formatDateTime(accessTokenExpiresAt) : '未知'}</strong>
          </div>
        </div>
        <Status state={accountRefresh} />
      </section>
      <section className="connect-panel">
        <div className="section-head">
          <h3>其他播放器</h3>
        </div>
        <div className="player-support-grid">
          {playerRecommendations.map(player => (
            <a className="player-card" href={player.name === 'ampcast' ? ampcastOfficialUrl : player.href} target="_blank" rel="noreferrer" key={player.name}>
              <span>{player.platform}</span>
              <strong>{player.name}</strong>
            </a>
          ))}
        </div>
      </section>
    </div>
  )
}

function PlayerPanel({ playerPath }: { playerPath: string }) {
  return (
    <div className="player-layout">
      <section className="ampcast-panel">
        <iframe title="ampcast" src={playerPath} />
      </section>
    </div>
  )
}

function ConfigPanel({
  draft,
  embyConfig,
  connection,
  passwordDraft,
  embyDsnDraft,
  embyWebdavDraft,
  embyProxyTimeoutDraft,
  incrementalSync,
  showSyncPrompt,
  onChange,
  onPasswordChange,
  onEmbyDsnChange,
  onEmbyWebdavChange,
  onEmbyProxyTimeoutChange,
  onSave,
  onIncrementalSync,
  onDismissSyncPrompt,
  loading,
}: {
  draft: ConfigDraft
  embyConfig: ApiState<AccountEmbyConfig>
  connection: ConnectionInfo
  passwordDraft: string
  embyDsnDraft: string
  embyWebdavDraft: string
  embyProxyTimeoutDraft: string
  incrementalSync: ApiState<IncrementalEmbySyncResult>
  showSyncPrompt: boolean
  onChange: (value: ConfigDraft) => void
  onPasswordChange: (value: string) => void
  onEmbyDsnChange: (value: string) => void
  onEmbyWebdavChange: (value: string) => void
  onEmbyProxyTimeoutChange: (value: string) => void
  onSave: () => void
  onIncrementalSync: () => void
  onDismissSyncPrompt: () => void
  loading: boolean
}) {
  const patch = (value: Partial<ConfigDraft>) => onChange({ ...draft, ...value })
  const [showPassword, setShowPassword] = useState(false)
  return (
    <div className="config-grid">
      <section>
        <h3>播放器</h3>
        <dl className="connection-list">
          <div>
            <dt>地址</dt>
            <dd><span>{connection.server || '-'}</span><CopyButton value={connection.server} label="复制地址" iconOnly /></dd>
          </div>
          <div>
            <dt>用户名</dt>
            <dd><span>{connection.username || '-'}</span><CopyButton value={connection.username} label="复制用户名" iconOnly /></dd>
          </div>
          <div>
            <dt>密码</dt>
            <dd>
              <input
                type={showPassword ? 'text' : 'password'}
                value={passwordDraft}
                onChange={event => onPasswordChange(event.target.value)}
                placeholder="请输入密码"
              />
              <span className="inline-actions">
                <IconButton label={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword(value => !value)} disabled={!passwordDraft}>
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </IconButton>
                <CopyButton value={passwordDraft} label="复制密码" iconOnly />
              </span>
            </dd>
          </div>
        </dl>
        <Status state={embyConfig} />
      </section>
      <section>
        <h3>Emby</h3>
        <dl className="connection-list">
          <div>
            <dt>服务器地址</dt>
            <dd>
              <input
                type="url"
                value={embyDsnDraft}
                onChange={event => onEmbyDsnChange(event.target.value)}
                placeholder="请输入 Emby 服务器地址"
              />
            </dd>
          </div>
          <div>
            <dt>WebDAV 存储</dt>
            <dd>
              <input
                type="url"
                value={embyWebdavDraft}
                onChange={event => onEmbyWebdavChange(event.target.value)}
                placeholder="请输入 WebDAV 地址"
              />
            </dd>
          </div>
          <div>
            <dt>连接超时</dt>
            <dd>
              <input
                type="number"
                min="1000"
                step="1000"
                value={embyProxyTimeoutDraft}
                onChange={event => onEmbyProxyTimeoutChange(event.target.value)}
              />
            </dd>
          </div>
        </dl>
      </section>
      <section>
        <h3>QQ 音乐</h3>
        <label className="check-row">
          <input type="checkbox" checked={draft.qqEnabled} onChange={event => patch({ qqEnabled: event.target.checked })} />
          <span>启用 QQ 音乐</span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={draft.qqSyncFavorites} onChange={event => patch({ qqSyncFavorites: event.target.checked })} />
          <span>同步我的收藏</span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={draft.qqSyncPlaylists} onChange={event => patch({ qqSyncPlaylists: event.target.checked })} />
          <span>同步歌单</span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={draft.qqSyncPlayHistory} onChange={event => patch({ qqSyncPlayHistory: event.target.checked })} />
          <span>同步播放历史</span>
        </label>
        {showSyncPrompt ? (
          <div className="sync-prompt">
            <p>Emby 已连接，可以开始同步。</p>
            <div className="toolbar">
              <button className="secondary-button compact-button" onClick={onDismissSyncPrompt}>稍后</button>
              <button className="compact-button" onClick={onIncrementalSync} disabled={incrementalSync.loading}><Workflow size={15} />立即同步</button>
            </div>
          </div>
        ) : null}
        <div className="toolbar">
          <button className="secondary-button compact-button" onClick={onIncrementalSync} disabled={incrementalSync.loading || !embyDsnDraft.trim()}>
            <Workflow size={15} />立即同步
          </button>
        </div>
        <Status state={incrementalSync} />
      </section>
      <div className="form-actions">
        <button onClick={onSave} disabled={loading}>保存配置</button>
      </div>
    </div>
  )
}

function HealthPanel({
  health,
  favoriteStatus,
  isAdmin,
  onSyncFavorites,
  onOpenConfig,
  onOpenJobs,
}: {
  health: HealthStatus
  favoriteStatus: ApiState<FavoriteStatusSummary>
  isAdmin: boolean
  onSyncFavorites: () => void
  onOpenConfig: () => void
  onOpenJobs: () => void
}) {
  const cacheEntries = Object.entries(health.resourceCache.byType)
  const archiveJob = health.sync.jobs.archive_track ?? emptyJobMetrics()
  const embySyncJob = health.sync.jobs.sync_emby_track ?? emptyJobMetrics()
  const tagJob = health.sync.jobs.tag_track_file ?? emptyJobMetrics()
  const hasJobPressure = archiveJob.failed + embySyncJob.failed + tagJob.failed > 0
  const hasQueuedJobs = archiveJob.queued + embySyncJob.queued + tagJob.queued > 0
  const accountLabel = health.account.qqNickname ?? (health.account.qqUin ? `QQ ${health.account.qqUin}` : '未登录')
  const pipelineTone = hasJobPressure ? 'bad' : hasQueuedJobs ? 'warn' : 'ok'
  return (
    <div className="ops-layout">
      <section className={health.ok ? 'status-banner ok' : 'status-banner attention'}>
        <div>
          <h3>{health.ok ? '运行正常' : '需要处理'}</h3>
          <p>更新于 {formatDateTime(health.checkedAt)}</p>
        </div>
        <div className="toolbar">
          {!health.account.embyConfigured || !health.account.webdavConfigured || health.account.qqAuthState !== 'active'
            ? <button className="secondary-button compact-button" onClick={onOpenConfig}><Settings size={15} />配置</button>
            : null}
          {isAdmin && hasJobPressure ? <button className="secondary-button compact-button" onClick={onOpenJobs}><Workflow size={15} />任务</button> : null}
        </div>
      </section>

      <section className="metric-grid">
        <MetricCard icon={UserRound} label="QQ 授权" value={qqAuthLabel(health.account.qqAuthState)} detail={accountLabel} tone={health.account.qqAuthState === 'active' ? 'ok' : 'bad'} />
        <MetricCard icon={KeyRound} label="音源" value={health.config.missing.length ? '未配置' : '可用'} detail={health.config.missing.length ? '请检查设置' : undefined} tone={health.config.missing.length ? 'bad' : 'ok'} />
        <MetricCard icon={MonitorPlay} label="Emby" value={health.account.embyConfigured ? '已连接' : '未连接'} detail={health.account.webdavConfigured ? '存储已连接' : undefined} tone={health.account.embyConfigured ? health.account.webdavConfigured ? 'ok' : 'warn' : 'warn'} />
        <MetricCard icon={Workflow} label="任务" value={pipelineLabel(pipelineTone)} detail={`${archiveJob.queued + embySyncJob.queued + tagJob.queued} 等待 · ${archiveJob.failed + embySyncJob.failed + tagJob.failed} 失败`} tone={pipelineTone} />
      </section>

      <section className="ops-grid">
        <article>
          <div className="section-head compact-head">
            <h3>帐号</h3>
            <button className="secondary-button compact-button" onClick={onOpenConfig}>
              <Settings size={15} />管理
            </button>
          </div>
          <div className="status-table">
            <div>
              <span>QQ 用户</span>
              <strong>{accountLabel}</strong>
            </div>
            <div>
              <span>播放器用户名</span>
              <strong>{health.account.embyGatewayUsername ?? '-'}</strong>
            </div>
            <div>
              <span>Emby</span>
              <strong>{health.account.embyConfigured ? '已连接' : '未连接'}</strong>
            </div>
            <div>
              <span>WebDAV</span>
              <strong>{health.account.webdavConfigured ? '已连接' : '未连接'}</strong>
            </div>
          </div>
        </article>

        <article>
          <div className="section-head compact-head">
            <h3>同步任务</h3>
            {isAdmin ? <button className="secondary-button compact-button" onClick={onOpenJobs}><Workflow size={15} />任务</button> : null}
          </div>
          <div className="status-table">
            <JobMetricRow label="歌曲归档" metrics={archiveJob} />
            <JobMetricRow label="Emby 同步" metrics={embySyncJob} />
            <JobMetricRow label="标签整理" metrics={tagJob} />
            <div>
              <span>近 7 天上传</span>
              <strong>{health.sync.webdav.uploaded + health.sync.webdav.skippedExisting}</strong>
              <small>{health.sync.webdav.uploaded} 上传 · {health.sync.webdav.skippedExisting} 已存在</small>
            </div>
          </div>
          {health.sync.recentFailures.length ? (
            <div className="failure-list">
              {health.sync.recentFailures.map(item => (
                <button key={item.id} className="failure-row" onClick={onOpenJobs}>
                  <span>#{item.id} {jobTypeLabel(item.type)}</span>
                  <small>{item.error || '未知错误'} · {formatDateTime(item.updatedAt)}</small>
                </button>
              ))}
            </div>
          ) : null}
        </article>

        <article>
          <div className="section-head compact-head">
            <h3>收藏同步</h3>
            <button className="secondary-button compact-button" onClick={onSyncFavorites} disabled={favoriteStatus.loading}>
              <Heart size={15} />同步收藏
            </button>
          </div>
          <Status state={favoriteStatus} />
          <div className="status-table">
            <div>
              <span>QQ 收藏</span>
              <strong>{favoriteStatus.data?.qqTotal ?? '-'}</strong>
            </div>
            <div>
              <span>Emby 收藏</span>
              <strong>{health.account.embyConfigured ? favoriteStatus.data?.embyTotal ?? '-' : '不适用'}</strong>
            </div>
            <div>
              <span>等待同步</span>
              <strong>{health.favorites.pendingCount}</strong>
            </div>
            <div>
              <span>同步失败</span>
              <strong>{health.favorites.failedCount}</strong>
              <small>{health.favorites.failedCount ? '请查看任务' : '无需处理'}</small>
            </div>
          </div>
        </article>

        <article>
          <h3>音频缓存</h3>
          <div className="status-table">
            <div>
              <span>全部音频</span>
              <strong>{health.audioCache.total}</strong>
              <small>{formatBytes(health.audioCache.totalBytes)}</small>
            </div>
            {['flac', '320k', '128k'].map(quality => {
              const item = health.audioCache.byQuality[quality]
              return (
                <div key={quality}>
                  <span>{qualityLabel(quality)}</span>
                  <strong>{item?.total ?? 0}</strong>
                  <small>{formatBytes(item?.bytes ?? 0)} · 可用 {item?.byStatus.ready ?? 0} · 失败 {item?.byStatus.failed ?? 0}</small>
                </div>
              )
            })}
            <div>
              <span>歌词 / 封面</span>
              <strong>{health.audioCache.lyrics + health.audioCache.covers}</strong>
              <small>{health.audioCache.lyrics} 份歌词 · {health.audioCache.covers} 张封面</small>
            </div>
            <div>
              <span>异常缓存</span>
              <strong>{health.audioCache.failed + health.audioCache.missing}</strong>
              <small>{health.audioCache.failed} 失败 · {health.audioCache.missing} 丢失</small>
            </div>
          </div>
        </article>

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

        {isAdmin ? (
          <article>
            <h3>系统存储</h3>
            <div className="status-table">
              <div>
                <span>曲库</span>
                <strong>{String(health.database.tracks ?? 0)}</strong>
                <small>{health.database.trackFiles ?? 0} 个文件 · {health.database.playEvents ?? 0} 次播放</small>
              </div>
              {Object.entries(health.cache).map(([key, item]) => (
                <div key={key}>
                  <span>{cacheDirectoryLabel(key)}</span>
                  <strong>{item.writable ? '可写' : '异常'}</strong>
                  <small>{item.path}</small>
                </div>
              ))}
            </div>
          </article>
        ) : null}
      </section>
    </div>
  )
}

function JobMetricRow({
  label,
  metrics,
}: {
  label: string
  metrics: { total: number; queued: number; running: number; completed: number; failed: number }
}) {
  return (
    <div>
      <span>{label}</span>
      <strong>{metrics.total}</strong>
      <small>{metrics.queued} 等待 · {metrics.running} 运行 · {metrics.failed} 失败</small>
    </div>
  )
}

function emptyJobMetrics() {
  return { total: 0, queued: 0, running: 0, completed: 0, failed: 0 }
}

function qqAuthLabel(status: HealthStatus['account']['qqAuthState']): string {
  if (status === 'active') return '有效'
  if (status === 'expired') return '已过期'
  return '未登录'
}

function pipelineLabel(tone: 'ok' | 'warn' | 'bad'): string {
  if (tone === 'bad') return '有失败'
  if (tone === 'warn') return '有等待'
  return '正常'
}

function jobTypeLabel(type: string): string {
  if (type === 'archive_track') return '歌曲归档'
  if (type === 'sync_emby_track') return 'Emby 同步'
  if (type === 'tag_track_file') return '标签整理'
  return type
}

function qualityLabel(quality: string): string {
  if (quality === 'flac') return '无损 FLAC'
  if (quality === '320k') return '高品质 320k'
  if (quality === '128k') return '标准 128k'
  return quality
}

function cacheDirectoryLabel(key: string): string {
  if (key === 'dataDir') return '数据目录'
  if (key === 'stagingDir') return '暂存目录'
  if (key === 'inboxDir') return '入库目录'
  if (key === 'musicDir') return '音乐目录'
  return key
}

function JobsPanel({ jobs }: { jobs: JobsResult }) {
  const [selectedJob, setSelectedJob] = useState<JobItem | null>(null)
  return (
    <div className="jobs-layout">
      <section className="metric-grid">
        <MetricCard icon={Workflow} label="全部" value={String(jobs.summary.total)} tone="ok" />
        <MetricCard icon={RefreshCw} label="等待" value={String(jobs.summary.queued)} detail={`${jobs.summary.running} 进行中`} tone={jobs.summary.queued ? 'warn' : 'ok'} />
        <MetricCard icon={CheckCircle2} label="已完成" value={String(jobs.summary.completed)} tone="ok" />
        <MetricCard icon={Activity} label="失败" value={String(jobs.summary.failed)} detail={jobs.summary.failed ? '需要处理' : undefined} tone={jobs.summary.failed ? 'bad' : 'ok'} />
      </section>

      <section className="jobs-table">
        <div className="job-row header">
          <span>编号</span>
          <span>类型</span>
          <span>状态</span>
          <span>尝试</span>
          <span>更新时间</span>
        </div>
        {jobs.items.map(job => (
          <button className={`job-row ${selectedJob?.id === job.id ? 'active' : ''}`} key={job.id} onClick={() => setSelectedJob(job)}>
            <span>#{job.id}</span>
            <span>{jobTypeLabel(job.type)}</span>
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

function UsersPanel({ users }: { users: UsersResult }) {
  const [selectedUser, setSelectedUser] = useState<UserItem | null>(null)
  const [profile, setProfile] = useState<ApiState<UserProfile>>(emptyState)
  const [favorites, setFavorites] = useState<ApiState<UserFavorites>>(emptyState)
  const [plays, setPlays] = useState<ApiState<UserPlays>>(emptyState)

  const openUser = async (user: UserItem) => {
    setSelectedUser(user)
    setProfile({ loading: true, error: '', data: null })
    setFavorites(emptyState)
    setPlays(emptyState)
    try {
      setProfile({ loading: false, error: '', data: await fetchJson<UserProfile>(`/api/admin/users?userId=${encodeURIComponent(user.userId)}&section=profile`) })
    } catch (error) {
      setProfile({ loading: false, error: error instanceof Error ? error.message : String(error), data: null })
    }
  }

  return (
    <div className="users-layout">
      <section className="users-table">
        <div className="user-row header">
          <span>用户</span>
          <span>权限</span>
          <span>播放</span>
          <span>收藏</span>
          <span>最近登录</span>
          <span>最近登录 IP</span>
          <span>最近使用</span>
        </div>
        {users.items.map(user => (
          <button className={`user-row ${selectedUser?.userId === user.userId ? 'active' : ''}`} key={user.userId} onClick={() => void openUser(user)}>
            <span className="user-cell-main"><strong>{user.username}</strong><small>{user.qqNickname ? `${user.qqNickname} · QQ ${user.qqUin}` : '未绑定 QQ'}</small></span>
            <span><StatusBadge status={user.isAdmin ? 'admin' : 'user'} /></span>
            <span className="numeric-cell">{user.playCount}</span>
            <span className="numeric-cell">{user.favoriteCount}</span>
            <span className="date-cell">{formatOptionalDateTime(user.lastLoginAt)}</span>
            <span className="ip-cell">{user.lastLoginIp ?? '-'}</span>
            <span className="date-cell">{formatOptionalDateTime(user.lastActiveAt)}</span>
          </button>
        ))}
        {!users.items.length ? <p>暂无用户</p> : null}
      </section>
      {selectedUser ? (
        <UserDetailDialog
          user={selectedUser}
          profile={profile}
          favorites={favorites}
          plays={plays}
          setFavorites={setFavorites}
          setPlays={setPlays}
          onClose={() => setSelectedUser(null)}
        />
      ) : null}
    </div>
  )
}

function UserDetailDialog({
  user,
  profile,
  favorites,
  plays,
  setFavorites,
  setPlays,
  onClose,
}: {
  user: UserItem
  profile: ApiState<UserProfile>
  favorites: ApiState<UserFavorites>
  plays: ApiState<UserPlays>
  setFavorites: (state: ApiState<UserFavorites>) => void
  setPlays: (state: ApiState<UserPlays>) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<UserDetailTab>('profile')
  const [favoritesPage, setFavoritesPage] = useState(1)
  const [playsPage, setPlaysPage] = useState(1)
  const account = profile.data?.account ?? user
  const accountTitle = account.username
  const favoriteBadge = favorites.data?.total ?? (favorites.loading ? '...' : '-')
  const playBadge = plays.data?.total ?? account.playCount
  const loadFavorites = async (page = favoritesPage, force = false) => {
    if (!force && favorites.data && favorites.data.page === page) return
    if (favorites.loading) return
    setFavorites({ loading: true, error: '', data: null })
    try {
      setFavorites({
        loading: false,
        error: '',
        data: await fetchJson<UserFavorites>(`/api/admin/users?userId=${encodeURIComponent(user.userId)}&section=favorites&page=${page}&limit=${userDetailPageSize}`),
      })
      setFavoritesPage(page)
    } catch (error) {
      setFavorites({ loading: false, error: error instanceof Error ? error.message : String(error), data: null })
    }
  }
  const loadPlays = async (page = playsPage, force = false) => {
    if (!force && plays.data && plays.data.page === page) return
    if (plays.loading) return
    setPlays({ loading: true, error: '', data: null })
    try {
      setPlays({
        loading: false,
        error: '',
        data: await fetchJson<UserPlays>(`/api/admin/users?userId=${encodeURIComponent(user.userId)}&section=plays&page=${page}&limit=${userDetailPageSize}`),
      })
      setPlaysPage(page)
    } catch (error) {
      setPlays({ loading: false, error: error instanceof Error ? error.message : String(error), data: null })
    }
  }
  const switchTab = (next: UserDetailTab) => {
    setTab(next)
    if (next === 'favorites') void loadFavorites()
    if (next === 'plays') void loadPlays()
  }

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <section className="user-detail dialog-panel" role="dialog" aria-modal="true" aria-labelledby="user-detail-title" onClick={event => event.stopPropagation()}>
        <div className="user-detail-head">
          <h3 id="user-detail-title">{accountTitle}</h3>
          <button className="secondary-button compact-button" onClick={onClose}>关闭</button>
        </div>
        <div className="detail-tabs" role="tablist" aria-label="用户详情">
          <button className={tab === 'profile' ? 'active' : ''} onClick={() => switchTab('profile')}>
            <span>用户信息</span><small>{account.isAdmin ? '管理员' : '用户'}</small>
          </button>
          <button className={tab === 'favorites' ? 'active' : ''} onClick={() => switchTab('favorites')}>
            <span>收藏歌曲</span><small>{favoriteBadge}</small>
          </button>
          <button className={tab === 'plays' ? 'active' : ''} onClick={() => switchTab('plays')}>
            <span>最近播放</span><small>{playBadge}</small>
          </button>
        </div>

        <div className="detail-tab-panel">
          {tab === 'profile' ? (
            <div className="detail-tab-content">
            <Status state={profile} />
            <dl className="user-info-grid">
              <div><dt>昵称</dt><dd><span>{account.qqNickname ?? '-'}</span></dd></div>
              <div><dt>用户名</dt><dd><span>{account.username}</span></dd></div>
              <div><dt>QQ</dt><dd><span>{account.qqUin ?? '-'}</span></dd></div>
              <div><dt>播放器用户名</dt><dd><span>{account.embyUsername}</span></dd></div>
              <div><dt>权限</dt><dd><span>{account.isAdmin ? '管理员' : '用户'}</span></dd></div>
              <div><dt>最近登录</dt><dd><span>{formatOptionalDateTime(account.lastLoginAt)}</span></dd></div>
              <div><dt>最近使用</dt><dd><span>{formatOptionalDateTime(account.lastActiveAt)}</span></dd></div>
              <div><dt>创建时间</dt><dd><span>{formatDateTime(account.createdAt)}</span></dd></div>
            </dl>
            <details className="technical-details">
              <summary>技术信息</summary>
              <dl className="user-info-grid">
                <div><dt>Emby ID</dt><dd><span>{account.embyUserId ?? '-'}</span></dd></div>
                <div><dt>QQ Key</dt><dd><span>{profile.data?.account.hasQQMusicKey ? '已保存' : '未保存'}</span></dd></div>
                <div><dt>加密 UIN</dt><dd><span>{profile.data?.account.encryptedUin ?? '-'}</span></dd></div>
                <div><dt>最近登录 IP</dt><dd><span>{account.lastLoginIp ?? '-'}</span></dd></div>
              </dl>
            </details>
            </div>
          ) : null}

          {tab === 'favorites' ? (
            <div className="detail-tab-content">
            <Status state={favorites} />
            {favorites.data ? (
              <UserTrackList
                title={`收藏歌曲 (${favorites.data.total})`}
                tracks={favorites.data.items}
                timeField="favoriteUpdatedAt"
                page={favorites.data.page ?? favoritesPage}
                limit={favorites.data.limit ?? userDetailPageSize}
              />
            ) : null}
            {favorites.data ? (
              <Pager
                page={favorites.data.page ?? favoritesPage}
                limit={favorites.data.limit ?? userDetailPageSize}
                total={favorites.data.total}
                loading={favorites.loading}
                onPage={page => void loadFavorites(page, true)}
              />
            ) : null}
            {favorites.data?.error ? <p className="status error">QQ 收藏读取失败，已显示本地记录：{favorites.data.error}</p> : null}
            {!favorites.data && !favorites.loading && !favorites.error ? <p className="empty-panel">切换到此页后加载收藏歌曲</p> : null}
            </div>
          ) : null}

          {tab === 'plays' ? (
            <div className="detail-tab-content">
            <Status state={plays} />
            {plays.data ? (
              <UserTrackList
                title={`最近播放 (${plays.data.items.length})`}
                tracks={plays.data.items}
                timeField="playedAt"
                page={plays.data.page}
                limit={plays.data.limit}
              />
            ) : null}
            {plays.data ? (
              <Pager
                page={plays.data.page}
                limit={plays.data.limit}
                total={plays.data.total}
                loading={plays.loading}
                onPage={page => void loadPlays(page, true)}
              />
            ) : null}
            {!plays.data && !plays.loading && !plays.error ? <p className="empty-panel">切换到此页后加载最近播放</p> : null}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  )
}

function UserTrackList({ title, tracks, timeField, page, limit }: {
  title: string
  tracks: UserTrackItem[]
  timeField: 'playedAt' | 'favoriteUpdatedAt'
  page: number
  limit: number
}) {
  return (
    <section className="user-track-list">
      <div className="section-head compact-head">
        <h4>{title}</h4>
      </div>
      <div className="mini-table">
        <div className="mini-row mini-header">
          <span>歌曲</span>
          <span>歌手</span>
          <span>时间</span>
        </div>
        {tracks.map((track, index) => (
          <div className="mini-row" key={`${page}-${(page - 1) * limit + index}-${track.source}-${track.songmid}-${track[timeField] ?? ''}`}>
            <span>{track.name}</span>
            <span>{track.singer}</span>
            <span>{formatOptionalDateTime(track[timeField])}</span>
          </div>
        ))}
        {!tracks.length ? <p className="empty-panel">暂无记录</p> : null}
      </div>
    </section>
  )
}

function Pager({ page, limit, total, loading, onPage }: {
  page: number
  limit: number
  total: number
  loading: boolean
  onPage: (page: number) => void
}) {
  const totalPages = Math.max(1, Math.ceil(total / limit))
  return (
    <div className="pager">
      <span>{page} / {totalPages}</span>
      <div>
        <button className="secondary-button compact-button" disabled={loading || page <= 1} onClick={() => onPage(page - 1)}>上一页</button>
        <button className="secondary-button compact-button" disabled={loading || page >= totalPages} onClick={() => onPage(page + 1)}>下一页</button>
      </div>
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
          <div><dt>类型</dt><dd><span>{jobTypeLabel(job.type)}</span></dd></div>
          <div><dt>状态</dt><dd><span>{statusLabel(job.status)}</span></dd></div>
          <div><dt>尝试次数</dt><dd><span>{job.attempts}</span></dd></div>
          <div><dt>创建时间</dt><dd><span>{formatDateTime(job.createdAt)}</span></dd></div>
          <div><dt>更新时间</dt><dd><span>{formatDateTime(job.updatedAt)}</span></dd></div>
        </dl>
        {job.error ? <p className="status error">{job.error}</p> : null}
        <details className="job-payload">
          <summary>详细信息</summary>
          <pre>{JSON.stringify(job.payload, null, 2)}</pre>
        </details>
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
  detail?: string
  tone: 'ok' | 'warn' | 'bad'
}) {
  return (
    <article className={`metric-card ${tone}`}>
      <Icon size={18} />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        {detail ? <small>{detail}</small> : null}
      </div>
    </article>
  )
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge ${status}`}>{statusLabel(status)}</span>
}

function statusLabel(status: string): string {
  if (status === 'queued') return '等待'
  if (status === 'running') return '进行中'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'admin') return '管理员'
  if (status === 'user') return '用户'
  return status
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
  if (view === 'home') return '首页'
  if (view === 'player') return '播放器'
  if (view === 'config') return '设置'
  if (view === 'users') return '用户'
  if (view === 'jobs') return '任务'
  return '状态'
}

function formatOptionalDateTime(value?: string): string {
  return value ? formatDateTime(value) : '-'
}

function formatDateTime(value: string): string {
  const date = new Date(normalizeDateTimeInput(value))
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function normalizeDateTimeInput(value: string): string {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) {
    return `${value.replace(' ', 'T')}Z`
  }
  return value
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
