'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Clock3,
  DownloadCloud,
  Heart,
  ListMusic,
  LogIn,
  LogOut,
  Radio,
  Play,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Star,
} from 'lucide-react'
import type { MusicInfo, PagedResult, PlayHistoryRecord, QQPlaylistDetail, QQPlaylistInfo, QQToplistInfo } from '@/lib/types'

type View = 'search' | 'toplists' | 'playlists' | 'favorites' | 'history' | 'recommendations' | 'config' | 'logs' | 'status'

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
}

interface FavoriteRecord extends MusicInfo {
  desiredState: 'favorite' | 'unfavorite'
  syncState: 'pending' | 'synced' | 'failed'
  error?: string
  updatedAt: string
}

interface FavoriteStatus {
  favorite: boolean
  pending: boolean
  desiredState: 'favorite' | 'unfavorite' | null
  syncState: 'pending' | 'synced' | 'failed' | null
  error?: string
}

interface HealthStatus {
  ok: boolean
  checkedAt: string
  database: { ok: boolean; tracks?: number; trackFiles?: number; playEvents?: number; error?: string }
  cache: Record<string, { path: string; exists: boolean; writable: boolean; isDirectory: boolean; entries: number; error?: string }>
  jobs: { byStatus: Record<string, number>; queued: number; running: number; failed: number }
  favorites: { favoriteCount: number; pendingCount: number; failedCount: number }
  config: { missing: string[]; lxMusicSourceScript: boolean }
}

interface AdminConfig {
  lx: { sourceScriptUrl?: string }
  emby: { baseUrl?: string; apiKey?: string; hasApiKey?: boolean; username?: string; hasPassword?: boolean; proxyTimeoutMs: number }
  qq: { enabled: boolean; syncFavorites: boolean; syncPlayHistory: boolean }
}

interface RequestLogRecord {
  id: number
  path: string
  method: string
  status: number
  durationMs: number
  source: 'local' | 'upstream'
  error?: string
  startedAt: string
  completedAt: string
}

type RecommendationsResult = PagedResult<MusicInfo> & {
  strategy?: string
  personalized?: boolean
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

const viewMeta: Record<View, { label: string; icon: React.ComponentType<{ size?: number }> }> = {
  search: { label: '搜索', icon: Search },
  toplists: { label: '排行', icon: Star },
  playlists: { label: '歌单', icon: ListMusic },
  favorites: { label: '收藏', icon: Heart },
  history: { label: '历史', icon: Clock3 },
  recommendations: { label: '猜你喜欢', icon: Sparkles },
  config: { label: '配置', icon: Settings },
  logs: { label: '日志', icon: Radio },
  status: { label: '状态', icon: Activity },
}

const playUrlFor = (song: MusicInfo): string => {
  const params = new URLSearchParams({
    source: song.source,
    songmid: song.songmid,
    name: song.name,
    singer: song.singer,
    quality: 'flac',
  })
  if (song.albumName) params.set('albumName', song.albumName)
  if (song.albumId) params.set('albumId', song.albumId)
  if (song.interval) params.set('interval', song.interval)
  if (song.img) params.set('img', song.img)
  return `/api/play?${params.toString()}`
}

const favoriteKey = (song: Pick<MusicInfo, 'source' | 'songmid'>): string => `${song.source}:${song.songmid}`

const favoritePayload = (song: MusicInfo, favorite: boolean) => ({
  source: song.source,
  songmid: song.songmid,
  name: song.name,
  singer: song.singer,
  albumName: song.albumName,
  albumId: song.albumId,
  interval: song.interval,
  img: song.img,
  raw: song.raw,
  favorite,
})

export default function MusicClient() {
  const [view, setView] = useState<View>('search')
  const [query, setQuery] = useState('周杰伦')
  const [playlistQuery, setPlaylistQuery] = useState('周杰伦')
  const [cookieText, setCookieText] = useState('')
  const [account, setAccount] = useState<ApiState<AccountState>>(emptyState)
  const [songs, setSongs] = useState<ApiState<PagedResult<MusicInfo>>>(emptyState)
  const [toplists, setToplists] = useState<ApiState<{ source: 'tx'; list: QQToplistInfo[] }>>(emptyState)
  const [toplistSongs, setToplistSongs] = useState<ApiState<PagedResult<MusicInfo>>>(emptyState)
  const [playlists, setPlaylists] = useState<ApiState<PagedResult<QQPlaylistInfo>>>(emptyState)
  const [userPlaylists, setUserPlaylists] = useState<ApiState<PagedResult<QQPlaylistInfo> & { offset: number }>>(emptyState)
  const [playlistDetail, setPlaylistDetail] = useState<ApiState<QQPlaylistDetail>>(emptyState)
  const [favorites, setFavorites] = useState<ApiState<{ source: 'local'; list: FavoriteRecord[] }>>(emptyState)
  const [history, setHistory] = useState<ApiState<{ source: 'local'; list: PlayHistoryRecord[] }>>(emptyState)
  const [recommendations, setRecommendations] = useState<ApiState<RecommendationsResult>>(emptyState)
  const [loginQr, setLoginQr] = useState<ApiState<LoginQrState>>(emptyState)
  const [avatar, setAvatar] = useState<ApiState<UserAvatarResult>>(emptyState)
  const [health, setHealth] = useState<ApiState<HealthStatus>>(emptyState)
  const [adminConfig, setAdminConfig] = useState<ApiState<AdminConfig>>(emptyState)
  const [requestLogs, setRequestLogs] = useState<ApiState<{ list: RequestLogRecord[] }>>(emptyState)
  const [configDraft, setConfigDraft] = useState({
    lxSourceScriptUrl: '',
    embyBaseUrl: '',
    embyDsn: '',
    embyApiKey: '',
    embyProxyTimeoutMs: 30000,
    qqEnabled: true,
    qqSyncFavorites: true,
    qqSyncPlayHistory: true,
  })
  const [favoriteStatuses, setFavoriteStatuses] = useState<Record<string, FavoriteStatus>>({})
  const [favoriteBusy, setFavoriteBusy] = useState<Record<string, boolean>>({})
  const [syncMessage, setSyncMessage] = useState('')
  const [currentSong, setCurrentSong] = useState<MusicInfo | null>(null)
  const [playerError, setPlayerError] = useState('')
  const audioRef = useRef<HTMLAudioElement>(null)

  const currentPlayUrl = useMemo(() => currentSong ? playUrlFor(currentSong) : '', [currentSong])

  const run = async <T,>(setter: (state: ApiState<T>) => void, task: () => Promise<T>) => {
    setter({ loading: true, error: '', data: null })
    try {
      setter({ loading: false, error: '', data: await task() })
    } catch (error) {
      setter({ loading: false, error: error instanceof Error ? error.message : String(error), data: null })
    }
  }

  const loadAccount = () => run(s => setAccount(s), () => fetchJson<AccountState>('/api/account'))
  const searchSongs = () => run(s => setSongs(s), () => fetchJson<PagedResult<MusicInfo>>(`/api/search/songs?q=${encodeURIComponent(query)}&limit=20`))
  const loadToplists = () => run(s => setToplists(s), () => fetchJson<{ source: 'tx'; list: QQToplistInfo[] }>('/api/toplists'))
  const loadToplistSongs = (id: string) => run(s => setToplistSongs(s), () => fetchJson<PagedResult<MusicInfo>>(`/api/toplists/${encodeURIComponent(id)}?limit=50`))
  const searchPlaylists = () => run(s => setPlaylists(s), () => fetchJson<PagedResult<QQPlaylistInfo>>(`/api/playlists?q=${encodeURIComponent(playlistQuery)}&limit=20`))
  const loadUserPlaylists = () => run(s => setUserPlaylists(s), () => fetchJson<PagedResult<QQPlaylistInfo> & { offset: number }>('/api/user/playlists?limit=30'))
  const openPlaylist = (id: string) => run(s => setPlaylistDetail(s), () => fetchJson<QQPlaylistDetail>(`/api/playlists/${encodeURIComponent(id)}`))
  const loadFavorites = () => run(s => setFavorites(s), () => fetchJson<{ source: 'local'; list: FavoriteRecord[] }>('/api/favorites'))
  const loadHistory = () => run(s => setHistory(s), () => fetchJson<{ source: 'local'; list: PlayHistoryRecord[] }>('/api/history?limit=100'))
  const loadRecommendations = () => run(s => setRecommendations(s), () => fetchJson<RecommendationsResult>('/api/recommendations?limit=30'))
  const loadAdminConfig = () => run(s => setAdminConfig(s), async () => {
    const data = await fetchJson<AdminConfig>('/api/admin/config')
    setConfigDraft({
      lxSourceScriptUrl: data.lx.sourceScriptUrl ?? '',
      embyBaseUrl: data.emby.baseUrl ?? '',
      embyDsn: '',
      embyApiKey: '',
      embyProxyTimeoutMs: data.emby.proxyTimeoutMs,
      qqEnabled: data.qq.enabled,
      qqSyncFavorites: data.qq.syncFavorites,
      qqSyncPlayHistory: data.qq.syncPlayHistory,
    })
    return data
  })
  const loadRequestLogs = () => run(s => setRequestLogs(s), () => fetchJson<{ list: RequestLogRecord[] }>('/api/admin/request-logs?limit=120'))
  const loadHealth = () => run(s => setHealth(s), async () => {
    const response = await fetch('/api/health')
    const body = await response.json().catch(() => undefined) as HealthStatus | undefined
    if (!body) throw new Error(`Request failed: ${response.status}`)
    return body
  })

  const login = async () => {
    setSyncMessage('')
    await run(s => setAccount(s), () => fetchJson<AccountState>('/api/account/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cookie: cookieText, persist: true }),
    }))
    setCookieText('')
  }

  const requestLoginQr = () => {
    setSyncMessage('')
    run(s => setLoginQr(s), () => fetchJson<LoginQrState>('/api/account/qr'))
  }

  const checkLoginQr = async () => {
    const qr = loginQr.data
    if (!qr) return
    setSyncMessage('')
    await run(s => setAccount(s), async () => {
      const result = await fetchJson<
        | { isOk: false; refresh: boolean; message: string }
        | { isOk: true; message: string; account: AccountState }
      >('/api/account/qr/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ptqrtoken: qr.ptqrtoken,
          qrsig: qr.qrsig,
          persist: true,
        }),
      })

      if (!result.isOk) {
        setSyncMessage(result.message)
        return account.data ?? { loggedIn: false }
      }

      setLoginQr(emptyState())
      setSyncMessage(result.message)
      return result.account
    })
  }

  const logout = async () => {
    setSyncMessage('')
    await run(s => setAccount(s), async () => {
      await fetchJson<{ loggedIn: false }>('/api/account', { method: 'DELETE' })
      return { loggedIn: false }
    })
  }

  const pushFavorites = async () => {
    setSyncMessage('')
    const result = await fetchJson<{ synced: number; failed: number; total: number }>('/api/favorites?sync=push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    setSyncMessage(`已推送 ${result.synced}/${result.total} 条，失败 ${result.failed} 条`)
    loadFavorites()
  }

  const pullFavorites = async () => {
    setSyncMessage('')
    const result = await fetchJson<{ pulled: number; list: FavoriteRecord[] }>('/api/favorites?sync=pull&limit=100')
    setFavorites({ loading: false, error: '', data: { source: 'local', list: result.list } })
    setSyncMessage(`已从 QQ 拉取 ${result.pulled} 首喜欢歌曲`)
  }

  const playSong = (song: MusicInfo) => {
    setPlayerError('')
    setCurrentSong(song)
    queueMicrotask(() => {
      void audioRef.current?.play().catch((error: unknown) => setPlayerError(playbackErrorMessage(error)))
    })
  }

  const toggleFavorite = async (song: MusicInfo) => {
    const key = favoriteKey(song)
    const nextFavorite = !(favoriteStatuses[key]?.favorite ?? false)
    setFavoriteBusy(previous => ({ ...previous, [key]: true }))
    try {
      const response = await fetchJson<{ favorite: boolean; pending: boolean; record: FavoriteRecord; remoteError?: string; remoteSynced?: boolean }>('/api/favorites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(favoritePayload(song, nextFavorite)),
      })
      setFavoriteStatuses(previous => ({
        ...previous,
        [key]: {
          favorite: response.favorite,
          pending: response.pending,
          desiredState: response.record.desiredState,
          syncState: response.record.syncState,
          error: response.remoteSynced ? undefined : response.remoteError ?? response.record.error,
        },
      }))
      if (view === 'favorites' || favorites.data) loadFavorites()
    } catch (error) {
      setFavoriteStatuses(previous => ({
        ...previous,
        [key]: {
          favorite: previous[key]?.favorite ?? false,
          pending: false,
          desiredState: previous[key]?.desiredState ?? null,
          syncState: 'failed',
          error: error instanceof Error ? error.message : String(error),
        },
      }))
    } finally {
      setFavoriteBusy(previous => ({ ...previous, [key]: false }))
    }
  }

  const openView = (next: View) => {
    setView(next)
    if (next === 'toplists' && !toplists.data) loadToplists()
    if (next === 'favorites') loadFavorites()
    if (next === 'history') loadHistory()
    if (next === 'recommendations') loadRecommendations()
    if (next === 'config') loadAdminConfig()
    if (next === 'logs') loadRequestLogs()
    if (next === 'status') loadHealth()
  }

  const saveAdminConfig = async () => {
    setSyncMessage('')
    const payload: Record<string, unknown> = {
      lxSourceScriptUrl: configDraft.lxSourceScriptUrl,
      embyBaseUrl: configDraft.embyBaseUrl,
      embyDsn: configDraft.embyDsn,
      embyProxyTimeoutMs: configDraft.embyProxyTimeoutMs,
      qqEnabled: configDraft.qqEnabled,
      qqSyncFavorites: configDraft.qqSyncFavorites,
      qqSyncPlayHistory: configDraft.qqSyncPlayHistory,
    }
    if (configDraft.embyApiKey.trim()) payload.embyApiKey = configDraft.embyApiKey
    await run(s => setAdminConfig(s), () => fetchJson<AdminConfig>('/api/admin/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }))
    setConfigDraft(previous => ({ ...previous, embyApiKey: '' }))
    setSyncMessage('配置已保存')
  }

  useEffect(() => {
    void loadAccount()
    void searchSongs()
  }, [])

  useEffect(() => {
    if (!account.data?.loggedIn || !account.data.uin) {
      setAvatar(emptyState())
      return
    }
    void run(s => setAvatar(s), () => fetchJson<UserAvatarResult>(`/api/user/avatar?uin=${encodeURIComponent(account.data!.uin!)}&size=100`))
  }, [account.data?.loggedIn, account.data?.uin])

  useEffect(() => {
    const visibleSongs = [
      ...(songs.data?.list ?? []),
      ...(toplistSongs.data?.list ?? []),
      ...(playlistDetail.data?.list ?? []),
      ...(favorites.data?.list ?? []),
      ...(history.data?.list ?? []),
      ...(recommendations.data?.list ?? []),
    ]
    const missing = visibleSongs.filter(song => favoriteStatuses[favoriteKey(song)] === undefined)
    if (!missing.length) return

    let cancelled = false
    void Promise.all(missing.map(async song => {
      const params = new URLSearchParams({ source: song.source, songmid: song.songmid })
      const status = await fetchJson<FavoriteStatus>(`/api/favorites/status?${params.toString()}`)
      return [favoriteKey(song), status] as const
    })).then(entries => {
      if (cancelled) return
      setFavoriteStatuses(previous => ({ ...previous, ...Object.fromEntries(entries) }))
    }).catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [songs.data, toplistSongs.data, playlistDetail.data, favorites.data, history.data, recommendations.data, favoriteStatuses])

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">
            <img src="/public/logo.svg" alt="" />
          </div>
          <div>
            <h1>miXmusic</h1>
            <span>QQ Music 控制台</span>
          </div>
        </div>
        <nav className="tabs" aria-label="主视图">
          {(Object.keys(viewMeta) as View[]).map(key => {
            const Icon = viewMeta[key].icon
            return (
              <button key={key} className={view === key ? 'active' : ''} onClick={() => openView(key)}>
                <Icon size={17} />
                <span>{viewMeta[key].label}</span>
              </button>
            )
          })}
        </nav>
        <AccountPanel
          account={account}
          cookieText={cookieText}
          onCookieTextChange={setCookieText}
          onLogin={login}
          onLogout={logout}
          loginQr={loginQr}
          avatarUrl={avatar.data?.avatarUrl}
          onRequestLoginQr={requestLoginQr}
          onCheckLoginQr={checkLoginQr}
        />
      </aside>

      <section className="content">
        <header className="content-header">
          <div>
            <p className="eyebrow">{viewMeta[view].label}</p>
            <h2>{headingFor(view)}</h2>
          </div>
          <div className="header-actions">
            {account.data?.loggedIn ? <span className="account-pill">QQ {account.data.uin}</span> : <span className="account-pill muted">未登录 QQ</span>}
          </div>
        </header>

        {view === 'search' && (
          <section className="workspace">
            <ToolbarSearch value={query} onChange={setQuery} onSubmit={searchSongs} loading={songs.loading} placeholder="搜索歌曲、歌手或专辑" />
            <Status state={songs} />
            <SongTable songs={songs.data?.list ?? []} onPlay={playSong} onFavorite={toggleFavorite} favoriteStatuses={favoriteStatuses} favoriteBusy={favoriteBusy} />
          </section>
        )}

        {view === 'toplists' && (
          <section className="workspace split">
            <div className="side-list">
              <div className="section-head">
                <h3>排行榜</h3>
                <IconButton label="刷新" onClick={loadToplists} disabled={toplists.loading}><RefreshCw size={16} /></IconButton>
              </div>
              <Status state={toplists} />
              <div className="board-list">
                {(toplists.data?.list ?? []).map(board => (
                  <button key={board.id} onClick={() => loadToplistSongs(board.id)}>{board.name}</button>
                ))}
              </div>
            </div>
            <div>
              <Status state={toplistSongs} />
              <SongTable songs={toplistSongs.data?.list ?? []} onPlay={playSong} onFavorite={toggleFavorite} favoriteStatuses={favoriteStatuses} favoriteBusy={favoriteBusy} compact />
            </div>
          </section>
        )}

        {view === 'playlists' && (
          <section className="workspace playlist-workspace">
            <div className="side-list">
              <ToolbarSearch value={playlistQuery} onChange={setPlaylistQuery} onSubmit={searchPlaylists} loading={playlists.loading} placeholder="搜索歌单" />
              <Status state={playlists} />
              <div className="playlist-list">
                {(playlists.data?.list ?? []).map(item => (
                  <button key={item.id} onClick={() => openPlaylist(item.id)}>
                    <span>{item.name}</span>
                    <small>{item.author ?? 'QQ 音乐'} · {item.total ?? 0} 首</small>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="section-head">
                <h3>{playlistDetail.data?.info.name ?? '歌单歌曲'}</h3>
              </div>
              <Status state={playlistDetail} />
              <SongTable songs={playlistDetail.data?.list ?? []} onPlay={playSong} onFavorite={toggleFavorite} favoriteStatuses={favoriteStatuses} favoriteBusy={favoriteBusy} compact />
            </div>
            <div className="side-list">
              <div className="section-head">
                <h3>我的歌单</h3>
                <IconButton label="刷新我的歌单" onClick={loadUserPlaylists} disabled={userPlaylists.loading}><RefreshCw size={16} /></IconButton>
              </div>
              <Status state={userPlaylists} />
              <div className="playlist-list">
                {(userPlaylists.data?.list ?? []).map(item => (
                  <button key={item.id} onClick={() => openPlaylist(item.id)}>
                    <span>{item.name}</span>
                    <small>{item.author ?? 'QQ 音乐'} · {item.total ?? 0} 首</small>
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}

        {view === 'favorites' && (
          <section className="workspace">
            <div className="action-strip">
              <div>
                <h3>本地与 QQ 喜欢</h3>
                <p>收藏操作会先写本地，并尽力同步到 QQ；失败项可手动推送。</p>
              </div>
              <div className="action-row">
                <button onClick={pullFavorites}><DownloadCloud size={16} />从 QQ 拉取</button>
                <button onClick={pushFavorites}><RefreshCw size={16} />推送待同步</button>
              </div>
            </div>
            {syncMessage ? <p className="status">{syncMessage}</p> : null}
            <Status state={favorites} />
            <SongTable songs={favorites.data?.list ?? []} onPlay={playSong} onFavorite={toggleFavorite} favoriteStatuses={favoriteStatuses} favoriteBusy={favoriteBusy} />
          </section>
        )}

        {view === 'history' && (
          <section className="workspace">
            <div className="section-head">
              <h3>播放历史</h3>
              <IconButton label="刷新" onClick={loadHistory} disabled={history.loading}><RefreshCw size={16} /></IconButton>
            </div>
            <Status state={history} />
            <HistoryList songs={history.data?.list ?? []} onPlay={playSong} onFavorite={toggleFavorite} favoriteStatuses={favoriteStatuses} favoriteBusy={favoriteBusy} />
          </section>
        )}

        {view === 'recommendations' && (
          <section className="workspace">
            <div className="action-strip">
              <div>
                <h3>{recommendations.data?.personalized ? '个性推荐' : '热门推荐'}</h3>
                <p>{recommendations.data?.strategy ? `策略：${recommendations.data.strategy}` : '优先使用 QQ 个性电台，失败时从收藏歌手与热榜补齐。'}</p>
              </div>
              <button onClick={loadRecommendations} disabled={recommendations.loading}><RefreshCw size={16} />刷新</button>
            </div>
            <Status state={recommendations} />
            <SongTable songs={recommendations.data?.list ?? []} onPlay={playSong} onFavorite={toggleFavorite} favoriteStatuses={favoriteStatuses} favoriteBusy={favoriteBusy} />
          </section>
        )}

        {view === 'config' && (
          <section className="workspace">
            <div className="section-head">
              <h3>服务配置</h3>
              <IconButton label="刷新" onClick={loadAdminConfig} disabled={adminConfig.loading}><RefreshCw size={16} /></IconButton>
            </div>
            {syncMessage ? <p className="status">{syncMessage}</p> : null}
            <Status state={adminConfig} />
            <ConfigPanel
              draft={configDraft}
              hasEmbyApiKey={Boolean(adminConfig.data?.emby.hasApiKey)}
              onChange={setConfigDraft}
              onSave={saveAdminConfig}
              loading={adminConfig.loading}
            />
          </section>
        )}

        {view === 'logs' && (
          <section className="workspace">
            <div className="section-head">
              <h3>请求日志</h3>
              <IconButton label="刷新" onClick={loadRequestLogs} disabled={requestLogs.loading}><RefreshCw size={16} /></IconButton>
            </div>
            <Status state={requestLogs} />
            <RequestLogTable logs={requestLogs.data?.list ?? []} />
          </section>
        )}

        {view === 'status' && (
          <section className="workspace">
            <div className="section-head">
              <h3>运行状态</h3>
              <IconButton label="刷新" onClick={loadHealth} disabled={health.loading}><RefreshCw size={16} /></IconButton>
            </div>
            <Status state={health} />
            {health.data ? <HealthPanel health={health.data} /> : null}
          </section>
        )}
      </section>

      <footer className="player-bar">
        <div className="now-playing">
          <button className="play-button static" aria-label="当前播放"><Play size={18} fill="currentColor" /></button>
          <div>
            <strong>{currentSong?.name ?? '未播放'}</strong>
            <span>{currentSong ? `${currentSong.singer}${currentSong.albumName ? ` · ${currentSong.albumName}` : ''}` : '选择一首歌曲开始播放'}</span>
            {playerError ? <em>{playerError}</em> : null}
          </div>
        </div>
        <audio ref={audioRef} src={currentSong ? currentPlayUrl : undefined} controls onError={() => {
          if (!currentPlayUrl) return
          void readPlaybackApiError(currentPlayUrl).then(setPlayerError)
        }} />
      </footer>
    </main>
  )
}

function AccountPanel({
  account,
  cookieText,
  onCookieTextChange,
  onLogin,
  onLogout,
  loginQr,
  avatarUrl,
  onRequestLoginQr,
  onCheckLoginQr,
}: {
  account: ApiState<AccountState>
  cookieText: string
  onCookieTextChange: (value: string) => void
  onLogin: () => void
  onLogout: () => void
  loginQr: ApiState<LoginQrState>
  avatarUrl?: string
  onRequestLoginQr: () => void
  onCheckLoginQr: () => void
}) {
  return (
    <section className="account-panel">
      <div className="section-head">
        <h3>QQ 登录</h3>
        {account.data?.loggedIn ? <button className="ghost-button" onClick={onLogout}><LogOut size={16} />登出</button> : null}
      </div>
      {account.data?.loggedIn ? (
        <div className="account-summary">
          {avatarUrl ? <img src={avatarUrl} alt="" /> : <div className="avatar-placeholder">{account.data.uin?.slice(-2) ?? 'QQ'}</div>}
          <dl className="account-facts">
            <div><dt>UIN</dt><dd>{account.data.uin}</dd></div>
            <div><dt>来源</dt><dd>{account.data.source}</dd></div>
            <div><dt>Key</dt><dd>{account.data.hasQQMusicKey ? 'ready' : 'missing'}</dd></div>
          </dl>
        </div>
      ) : (
        <div className="login-box">
          {loginQr.data ? (
            <div className="qr-login">
              <img src={loginQr.data.img} alt="QQ 登录二维码" />
              <button onClick={onCheckLoginQr} disabled={account.loading}><RefreshCw size={16} />检查扫码</button>
            </div>
          ) : null}
          <button onClick={onRequestLoginQr} disabled={loginQr.loading}><LogIn size={16} />获取扫码登录</button>
          <Status state={loginQr} />
          <textarea value={cookieText} onChange={event => onCookieTextChange(event.target.value)} placeholder="粘贴 y.qq.com 已登录请求里的 Cookie" />
          <button onClick={onLogin} disabled={account.loading || !cookieText.trim()}><LogIn size={16} />保存登录</button>
        </div>
      )}
      <Status state={account} />
    </section>
  )
}

function ToolbarSearch({
  value,
  onChange,
  onSubmit,
  loading,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  loading: boolean
  placeholder: string
}) {
  return (
    <div className="search-row">
      <Search size={18} />
      <input value={value} placeholder={placeholder} onChange={event => onChange(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') onSubmit() }} />
      <button onClick={onSubmit} disabled={loading}>搜索</button>
    </div>
  )
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

function SongTable({
  songs,
  onPlay,
  onFavorite,
  favoriteStatuses,
  favoriteBusy,
  compact = false,
}: {
  songs: MusicInfo[]
  onPlay: (song: MusicInfo) => void
  onFavorite: (song: MusicInfo) => void
  favoriteStatuses: Record<string, FavoriteStatus>
  favoriteBusy: Record<string, boolean>
  compact?: boolean
}) {
  if (!songs.length) return <p className="empty">暂无歌曲</p>
  return (
    <div className={compact ? 'song-list compact' : 'song-list'}>
      {songs.map(song => {
        const key = favoriteKey(song)
        const status = favoriteStatuses[key]
        return (
          <article key={`${song.source}-${song.songmid}`} className="song-row">
            <button className="play-button" onClick={() => onPlay(song)} aria-label={`播放 ${song.name}`} title="播放">
              <Play size={16} fill="currentColor" />
            </button>
            <button
              className={status?.favorite ? 'favorite-button active' : 'favorite-button'}
              onClick={() => onFavorite(song)}
              disabled={favoriteBusy[key]}
              aria-label={`${status?.favorite ? '取消收藏' : '收藏'} ${song.name}`}
              title={favoriteTitle(status)}
            >
              <Heart size={16} fill={status?.favorite ? 'currentColor' : 'none'} />
            </button>
            <div className="song-main">
              <strong>{song.name}</strong>
              <span>{song.singer}{status?.favorite && status.pending ? ' · 待同步' : ''}</span>
            </div>
            <div className="song-meta">
              <span>{song.albumName ?? '-'}</span>
              <small>{song.interval ?? ''}</small>
            </div>
          </article>
        )
      })}
    </div>
  )
}

function HistoryList({
  songs,
  onPlay,
  onFavorite,
  favoriteStatuses,
  favoriteBusy,
}: {
  songs: PlayHistoryRecord[]
  onPlay: (song: MusicInfo) => void
  onFavorite: (song: MusicInfo) => void
  favoriteStatuses: Record<string, FavoriteStatus>
  favoriteBusy: Record<string, boolean>
}) {
  if (!songs.length) return <p className="empty">暂无播放历史</p>
  return (
    <div className="history-list">
      {songs.map(song => {
        const key = favoriteKey(song)
        const status = favoriteStatuses[key]
        return (
          <article key={song.playEventId} className="history-item">
            <div className="history-actions">
              <button className="play-button" onClick={() => onPlay(song)} aria-label={`播放 ${song.name}`} title="播放">
                <Play size={16} fill="currentColor" />
              </button>
              <button
                className={status?.favorite ? 'favorite-button active' : 'favorite-button'}
                onClick={() => onFavorite(song)}
                disabled={favoriteBusy[key]}
                aria-label={`${status?.favorite ? '取消收藏' : '收藏'} ${song.name}`}
                title={favoriteTitle(status)}
              >
                <Heart size={16} fill={status?.favorite ? 'currentColor' : 'none'} />
              </button>
            </div>
            <div className="history-main">
              <strong>{song.name}</strong>
              <span>{song.singer}{status?.favorite && status.pending ? ' · 待同步' : ''}</span>
            </div>
            <div className="history-meta">
              <span>{song.albumName ?? '-'}</span>
              <small>{song.interval ?? ''}</small>
            </div>
            <time>{formatPlayedAt(song.playedAt)} · {song.quality}</time>
          </article>
        )
      })}
    </div>
  )
}

function formatPlayedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function playbackErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('no supported source') || message.includes('NotSupportedError')) {
    return '播放失败：音源 API 未返回可播放地址。'
  }
  return message || '播放失败：音源 API 未返回可播放地址。'
}

async function readPlaybackApiError(url: string): Promise<string> {
  try {
    const response = await fetch(url, { headers: { accept: 'application/json', range: 'bytes=1-1' } })
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('application/json')) {
      return '播放失败：浏览器无法播放当前音频格式。'
    }

    const body = await response.json().catch(() => undefined) as unknown
    if (body && typeof body === 'object' && 'error' in body) {
      return String((body as { error: unknown }).error)
    }
    return response.ok
      ? '播放失败：浏览器无法播放当前音频格式。'
      : `播放失败：音源 API 返回 ${response.status}`
  } catch (error) {
    return playbackErrorMessage(error)
  }
}

function favoriteTitle(status: FavoriteStatus | undefined): string {
  if (!status) return '收藏'
  if (status.error) return status.error
  if (!status.pending) return status.favorite ? '取消收藏' : '收藏'
  return status.favorite ? '等待同步收藏到 QQ' : '等待同步取消收藏到 QQ'
}

function headingFor(view: View): string {
  if (view === 'search') return '搜索并播放 QQ 音乐'
  if (view === 'toplists') return '按榜单快速发现'
  if (view === 'playlists') return '检索公开歌单'
  if (view === 'favorites') return '收藏与喜欢同步'
  if (view === 'history') return '播放历史'
  if (view === 'recommendations') return '猜你喜欢'
  if (view === 'config') return '管理同步与上游服务'
  if (view === 'logs') return '代理与管理请求日志'
  return '系统健康与缓存'
}

function ConfigPanel({
  draft,
  hasEmbyApiKey,
  onChange,
  onSave,
  loading,
}: {
  draft: {
    lxSourceScriptUrl: string
    embyBaseUrl: string
    embyDsn: string
    embyApiKey: string
    embyProxyTimeoutMs: number
    qqEnabled: boolean
    qqSyncFavorites: boolean
    qqSyncPlayHistory: boolean
  }
  hasEmbyApiKey: boolean
  onChange: (value: {
    lxSourceScriptUrl: string
    embyBaseUrl: string
    embyDsn: string
    embyApiKey: string
    embyProxyTimeoutMs: number
    qqEnabled: boolean
    qqSyncFavorites: boolean
    qqSyncPlayHistory: boolean
  }) => void
  onSave: () => void
  loading: boolean
}) {
  const patch = (value: Partial<typeof draft>) => onChange({ ...draft, ...value })
  return (
    <div className="config-grid">
      <section>
        <h3>LX 音源</h3>
        <label>
          <span>脚本 URL</span>
          <input value={draft.lxSourceScriptUrl} onChange={event => patch({ lxSourceScriptUrl: event.target.value })} placeholder="https://..." />
        </label>
      </section>
      <section>
        <h3>上游 Emby</h3>
        <label>
          <span>DSN</span>
          <input value={draft.embyDsn} onChange={event => patch({ embyDsn: event.target.value })} placeholder="https://user:pass@host:8096/" />
        </label>
        <label>
          <span>Base URL</span>
          <input value={draft.embyBaseUrl} onChange={event => patch({ embyBaseUrl: event.target.value })} placeholder="http://emby:8096" />
        </label>
        <label>
          <span>API Key{hasEmbyApiKey ? '（已保存）' : ''}</span>
          <input value={draft.embyApiKey} onChange={event => patch({ embyApiKey: event.target.value })} placeholder={hasEmbyApiKey ? '留空保留现有 key' : 'X-Emby-Token'} />
        </label>
        <label>
          <span>代理超时 ms</span>
          <input type="number" min={1000} step={1000} value={draft.embyProxyTimeoutMs} onChange={event => patch({ embyProxyTimeoutMs: Number(event.target.value) })} />
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
          <span>同步收藏</span>
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

function RequestLogTable({ logs }: { logs: RequestLogRecord[] }) {
  if (!logs.length) return <p className="empty">暂无请求日志</p>
  return (
    <div className="log-table">
      {logs.map(log => (
        <article key={log.id} className="log-row">
          <strong>{log.method}</strong>
          <span>{log.path}</span>
          <small className={log.status >= 400 ? 'bad' : ''}>{log.status}</small>
          <small>{log.source}</small>
          <small>{log.durationMs}ms</small>
          <time>{formatPlayedAt(log.completedAt)}</time>
          {log.error ? <em>{log.error}</em> : null}
        </article>
      ))}
    </div>
  )
}

function HealthPanel({ health }: { health: HealthStatus }) {
  return (
    <div className="health-grid">
      <section>
        <h3>{health.ok ? 'OK' : 'Needs Attention'}</h3>
        <p>{health.checkedAt}</p>
      </section>
      <section>
        <h3>Database</h3>
        <p>tracks {health.database.tracks ?? 0} · files {health.database.trackFiles ?? 0} · plays {health.database.playEvents ?? 0}</p>
        {health.database.error ? <p className="status error">{health.database.error}</p> : null}
      </section>
      <section>
        <h3>Jobs</h3>
        <p>queued {health.jobs.queued} · running {health.jobs.running} · failed {health.jobs.failed}</p>
      </section>
      <section>
        <h3>Favorites</h3>
        <p>local {health.favorites.favoriteCount} · pending {health.favorites.pendingCount} · failed {health.favorites.failedCount}</p>
      </section>
      <section>
        <h3>Config</h3>
        <p>{health.config.missing.length ? `missing ${health.config.missing.join(', ')}` : 'required config present'}</p>
      </section>
      <section>
        <h3>Cache</h3>
        {Object.entries(health.cache).map(([name, item]) => (
          <p key={name}>{name}: {item.writable ? 'writable' : 'blocked'} · {item.entries} entries</p>
        ))}
      </section>
    </div>
  )
}
