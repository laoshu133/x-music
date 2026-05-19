'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { MusicInfo, PagedResult, QQPlaylistDetail, QQPlaylistInfo, QQToplistInfo } from '@/lib/types'

type View = 'search' | 'toplists' | 'playlists' | 'favorites' | 'recommendations' | 'status'

interface ApiState<T> {
  loading: boolean
  error: string
  data: T | null
}

const emptyState = <T,>(): ApiState<T> => ({ loading: false, error: '', data: null })

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
  database: {
    ok: boolean
    tracks?: number
    trackFiles?: number
    playEvents?: number
    error?: string
  }
  cache: Record<string, { path: string; exists: boolean; writable: boolean; isDirectory: boolean; entries: number; error?: string }>
  jobs: {
    byStatus: Record<string, number>
    queued: number
    running: number
    failed: number
  }
  favorites: {
    favoriteCount: number
    pendingCount: number
    failedCount: number
  }
  config: {
    missing: string[]
    lxMusicUrlScript: boolean
  }
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
  const [songs, setSongs] = useState<ApiState<PagedResult<MusicInfo>>>(emptyState)
  const [toplists, setToplists] = useState<ApiState<{ source: 'tx'; list: QQToplistInfo[] }>>(emptyState)
  const [toplistSongs, setToplistSongs] = useState<ApiState<PagedResult<MusicInfo>>>(emptyState)
  const [playlists, setPlaylists] = useState<ApiState<PagedResult<QQPlaylistInfo>>>(emptyState)
  const [playlistDetail, setPlaylistDetail] = useState<ApiState<QQPlaylistDetail>>(emptyState)
  const [favorites, setFavorites] = useState<ApiState<{ source: 'local'; list: FavoriteRecord[] }>>(emptyState)
  const [recommendations, setRecommendations] = useState<ApiState<PagedResult<MusicInfo>>>(emptyState)
  const [health, setHealth] = useState<ApiState<HealthStatus>>(emptyState)
  const [favoriteStatuses, setFavoriteStatuses] = useState<Record<string, FavoriteStatus>>({})
  const [favoriteBusy, setFavoriteBusy] = useState<Record<string, boolean>>({})
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

  const searchSongs = () => {
    void run(s => setSongs(s), () => fetchJson<PagedResult<MusicInfo>>(`/api/search/songs?q=${encodeURIComponent(query)}&limit=20`))
  }

  const loadToplists = () => {
    void run(s => setToplists(s), () => fetchJson<{ source: 'tx'; list: QQToplistInfo[] }>('/api/toplists'))
  }

  const loadToplistSongs = (id: string) => {
    void run(s => setToplistSongs(s), () => fetchJson<PagedResult<MusicInfo>>(`/api/toplists/${encodeURIComponent(id)}?limit=50`))
  }

  const searchPlaylists = () => {
    void run(s => setPlaylists(s), () => fetchJson<PagedResult<QQPlaylistInfo>>(`/api/playlists?q=${encodeURIComponent(playlistQuery)}&limit=20`))
  }

  const openPlaylist = (id: string) => {
    void run(s => setPlaylistDetail(s), () => fetchJson<QQPlaylistDetail>(`/api/playlists/${encodeURIComponent(id)}`))
  }

  const loadFavorites = () => {
    void run(s => setFavorites(s), () => fetchJson<{ source: 'local'; list: FavoriteRecord[] }>('/api/favorites'))
  }

  const loadRecommendations = () => {
    void run(s => setRecommendations(s), () => fetchJson<PagedResult<MusicInfo>>('/api/recommendations?limit=30'))
  }

  const loadHealth = () => {
    void run(s => setHealth(s), async () => {
      const response = await fetch('/api/health')
      const body = await response.json().catch(() => undefined) as HealthStatus | undefined
      if (!body) throw new Error(`Request failed: ${response.status}`)
      return body
    })
  }

  const playSong = (song: MusicInfo) => {
    setPlayerError('')
    setCurrentSong(song)
    queueMicrotask(() => {
      void audioRef.current?.play().catch((error: unknown) => {
        setPlayerError(playbackErrorMessage(error))
      })
    })
  }

  const toggleFavorite = async (song: MusicInfo) => {
    const key = favoriteKey(song)
    const nextFavorite = !(favoriteStatuses[key]?.favorite ?? false)
    setFavoriteBusy(previous => ({ ...previous, [key]: true }))
    try {
      const response = await fetchJson<{ favorite: boolean; pending: boolean; record: FavoriteRecord }>('/api/favorites', {
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
          error: response.record.error,
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

  useEffect(() => {
    const visibleSongs = [
      ...(songs.data?.list ?? []),
      ...(toplistSongs.data?.list ?? []),
      ...(playlistDetail.data?.list ?? []),
      ...(favorites.data?.list ?? []),
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
      setFavoriteStatuses(previous => ({
        ...previous,
        ...Object.fromEntries(entries),
      }))
    }).catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [songs.data, toplistSongs.data, playlistDetail.data, favorites.data, recommendations.data, favoriteStatuses])

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>miXmusic</h1>
          <p>QQ 音乐私有播放器，本地转存缓存优先。</p>
        </div>
        <nav className="tabs" aria-label="主视图">
          <button className={view === 'search' ? 'active' : ''} onClick={() => setView('search')}>搜索</button>
          <button className={view === 'toplists' ? 'active' : ''} onClick={() => { setView('toplists'); if (!toplists.data) loadToplists() }}>排行榜</button>
          <button className={view === 'playlists' ? 'active' : ''} onClick={() => setView('playlists')}>歌单</button>
          <button className={view === 'favorites' ? 'active' : ''} onClick={() => { setView('favorites'); loadFavorites() }}>收藏</button>
          <button className={view === 'recommendations' ? 'active' : ''} onClick={() => { setView('recommendations'); loadRecommendations() }}>猜你喜欢</button>
          <button className={view === 'status' ? 'active' : ''} onClick={() => { setView('status'); loadHealth() }}>状态</button>
        </nav>
      </header>

      {view === 'search' && (
        <section className="workspace">
          <div className="panel control-panel">
            <h2>歌曲搜索</h2>
            <div className="search-row">
              <input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') searchSongs() }} />
              <button onClick={searchSongs} disabled={songs.loading}>搜索</button>
            </div>
            <Status state={songs} />
          </div>
          <SongTable songs={songs.data?.list ?? []} onPlay={playSong} onFavorite={toggleFavorite} favoriteStatuses={favoriteStatuses} favoriteBusy={favoriteBusy} />
        </section>
      )}

      {view === 'toplists' && (
        <section className="workspace two-col">
          <div className="panel list-panel">
            <div className="panel-head">
              <h2>排行榜</h2>
              <button onClick={loadToplists} disabled={toplists.loading}>刷新</button>
            </div>
            <Status state={toplists} />
            <div className="board-list">
              {(toplists.data?.list ?? []).map(board => (
                <button key={board.id} onClick={() => loadToplistSongs(board.id)}>{board.name}</button>
              ))}
            </div>
          </div>
          <div className="panel">
            <h2>榜单歌曲</h2>
            <Status state={toplistSongs} />
            <SongTable songs={toplistSongs.data?.list ?? []} onPlay={playSong} onFavorite={toggleFavorite} favoriteStatuses={favoriteStatuses} favoriteBusy={favoriteBusy} compact />
          </div>
        </section>
      )}

      {view === 'playlists' && (
        <section className="workspace two-col">
          <div className="panel list-panel">
            <h2>歌单搜索</h2>
            <div className="search-row">
              <input value={playlistQuery} onChange={event => setPlaylistQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') searchPlaylists() }} />
              <button onClick={searchPlaylists} disabled={playlists.loading}>搜索</button>
            </div>
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
          <div className="panel">
            <h2>{playlistDetail.data?.info.name ?? '歌单歌曲'}</h2>
            <Status state={playlistDetail} />
            <SongTable songs={playlistDetail.data?.list ?? []} onPlay={playSong} onFavorite={toggleFavorite} favoriteStatuses={favoriteStatuses} favoriteBusy={favoriteBusy} compact />
          </div>
        </section>
      )}

      {view === 'favorites' && (
        <section className="workspace">
          <div className="panel control-panel">
            <div className="panel-head">
              <h2>本地收藏</h2>
              <button onClick={loadFavorites} disabled={favorites.loading}>刷新</button>
            </div>
            <p>收藏变更先写入本地 pending 队列，等待后续 QQ 同步接口接管。</p>
            <Status state={favorites} />
          </div>
          <SongTable songs={favorites.data?.list ?? []} onPlay={playSong} onFavorite={toggleFavorite} favoriteStatuses={favoriteStatuses} favoriteBusy={favoriteBusy} />
        </section>
      )}

      {view === 'recommendations' && (
        <section className="workspace">
          <div className="panel control-panel">
            <div className="panel-head">
              <h2>猜你喜欢</h2>
              <button onClick={loadRecommendations} disabled={recommendations.loading}>刷新</button>
            </div>
            <p>入口已预留；当远端 `/api/recommendations` 合流后会直接显示推荐歌曲。</p>
            <Status state={recommendations} />
          </div>
          <SongTable songs={recommendations.data?.list ?? []} onPlay={playSong} onFavorite={toggleFavorite} favoriteStatuses={favoriteStatuses} favoriteBusy={favoriteBusy} />
        </section>
      )}

      {view === 'status' && (
        <section className="workspace">
          <div className="panel control-panel">
            <div className="panel-head">
              <h2>运行状态</h2>
              <button onClick={loadHealth} disabled={health.loading}>刷新</button>
            </div>
            <Status state={health} />
            {health.data ? <HealthPanel health={health.data} /> : null}
          </div>
        </section>
      )}

      <footer className="player-bar">
        <div>
          <strong>{currentSong?.name ?? '未播放'}</strong>
          <span>{currentSong ? `${currentSong.singer}${currentSong.albumName ? ` · ${currentSong.albumName}` : ''}` : '选择一首歌曲开始播放'}</span>
          {playerError ? <em>{playerError}</em> : null}
        </div>
        <audio ref={audioRef} src={currentSong ? currentPlayUrl : undefined} controls onError={() => setPlayerError('播放失败，请检查 LX_MUSIC_URL_SCRIPT 和音源可用性')} />
      </footer>
    </main>
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
            <button className="play-button" onClick={() => onPlay(song)} aria-label={`播放 ${song.name}`}>▶</button>
            <button
              className={status?.favorite ? 'favorite-button active' : 'favorite-button'}
              onClick={() => onFavorite(song)}
              disabled={favoriteBusy[key]}
              aria-label={`${status?.favorite ? '取消收藏' : '收藏'} ${song.name}`}
              title={favoriteTitle(status)}
            >
              {status?.favorite ? '★' : '☆'}
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

function playbackErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('no supported source') || message.includes('NotSupportedError')) {
    return '播放失败：未配置或不可用的音源，请检查 LX_MUSIC_URL_SCRIPT。'
  }
  return message || '播放失败，请检查 LX_MUSIC_URL_SCRIPT 和音源可用性。'
}

function favoriteTitle(status: FavoriteStatus | undefined): string {
  if (!status) return ''
  if (status.error) return status.error
  if (!status.pending) return ''
  return status.favorite ? '等待同步收藏到 QQ' : '等待同步取消收藏到 QQ'
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
