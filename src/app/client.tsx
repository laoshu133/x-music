'use client'

import { useMemo, useRef, useState } from 'react'
import type { MusicInfo, PagedResult, QQPlaylistDetail, QQPlaylistInfo, QQToplistInfo } from '@/lib/types'

type View = 'search' | 'toplists' | 'playlists'

interface ApiState<T> {
  loading: boolean
  error: string
  data: T | null
}

const emptyState = <T,>(): ApiState<T> => ({ loading: false, error: '', data: null })

const fetchJson = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url)
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

export default function MusicClient() {
  const [view, setView] = useState<View>('search')
  const [query, setQuery] = useState('周杰伦')
  const [playlistQuery, setPlaylistQuery] = useState('周杰伦')
  const [songs, setSongs] = useState<ApiState<PagedResult<MusicInfo>>>(emptyState)
  const [toplists, setToplists] = useState<ApiState<{ source: 'tx'; list: QQToplistInfo[] }>>(emptyState)
  const [toplistSongs, setToplistSongs] = useState<ApiState<PagedResult<MusicInfo>>>(emptyState)
  const [playlists, setPlaylists] = useState<ApiState<PagedResult<QQPlaylistInfo>>>(emptyState)
  const [playlistDetail, setPlaylistDetail] = useState<ApiState<QQPlaylistDetail>>(emptyState)
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

  const playSong = (song: MusicInfo) => {
    setPlayerError('')
    setCurrentSong(song)
    queueMicrotask(() => {
      void audioRef.current?.play().catch((error: unknown) => {
        setPlayerError(error instanceof Error ? error.message : String(error))
      })
    })
  }

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
          <SongTable songs={songs.data?.list ?? []} onPlay={playSong} />
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
            <SongTable songs={toplistSongs.data?.list ?? []} onPlay={playSong} compact />
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
            <SongTable songs={playlistDetail.data?.list ?? []} onPlay={playSong} compact />
          </div>
        </section>
      )}

      <footer className="player-bar">
        <div>
          <strong>{currentSong?.name ?? '未播放'}</strong>
          <span>{currentSong ? `${currentSong.singer}${currentSong.albumName ? ` · ${currentSong.albumName}` : ''}` : '选择一首歌曲开始播放'}</span>
          {playerError ? <em>{playerError}</em> : null}
        </div>
        <audio ref={audioRef} src={currentPlayUrl} controls onError={() => setPlayerError('播放失败，请检查 LX_MUSIC_URL_SCRIPT 和音源可用性')} />
      </footer>
    </main>
  )
}

function Status<T>({ state }: { state: ApiState<T> }) {
  if (state.loading) return <p className="status">加载中...</p>
  if (state.error) return <p className="status error">{state.error}</p>
  return null
}

function SongTable({ songs, onPlay, compact = false }: { songs: MusicInfo[]; onPlay: (song: MusicInfo) => void; compact?: boolean }) {
  if (!songs.length) return <p className="empty">暂无歌曲</p>
  return (
    <div className={compact ? 'song-list compact' : 'song-list'}>
      {songs.map(song => (
        <article key={`${song.source}-${song.songmid}`} className="song-row">
          <button className="play-button" onClick={() => onPlay(song)} aria-label={`播放 ${song.name}`}>▶</button>
          <div className="song-main">
            <strong>{song.name}</strong>
            <span>{song.singer}</span>
          </div>
          <div className="song-meta">
            <span>{song.albumName ?? '-'}</span>
            <small>{song.interval ?? ''}</small>
          </div>
        </article>
      ))}
    </div>
  )
}
