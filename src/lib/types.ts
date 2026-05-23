export type OnlineSource = 'tx'

export type MusicQuality = 'flac' | '320k' | '128k'

export interface MusicInfo {
  source: OnlineSource
  songmid: string
  name: string
  singer: string
  albumName?: string
  albumId?: string
  interval?: string
  img?: string
  types?: Array<{ type: MusicQuality | string; size?: string }>
  raw?: unknown
}

export interface PagedResult<T> {
  source: OnlineSource
  list: T[]
  page: number
  limit: number
  total: number
  allPage?: number
}

export interface QQToplistInfo {
  source: OnlineSource
  id: string
  name: string
  bangid: string
}

export interface QQPlaylistInfo {
  source: OnlineSource
  id: string
  name: string
  author?: string
  img?: string
  desc?: string
  total?: number
  playCount?: string
  time?: string
}

export interface QQPlaylistDetail {
  source: OnlineSource
  info: QQPlaylistInfo
  list: MusicInfo[]
  page: number
  limit: number
  total: number
}

export interface ResolvedMusicUrl {
  url: string
  quality: MusicQuality
  source: OnlineSource
  songmid: string
  ekey?: string
  expiresAt?: Date
}

export type TrackFileStatus =
  | 'missing'
  | 'resolving_url'
  | 'streaming_and_caching'
  | 'cached_raw'
  | 'tagging'
  | 'ready'
  | 'failed'

export interface TrackRecord {
  id: number
  source: OnlineSource
  songmid: string
  name: string
  singer: string
  albumName?: string
  albumId?: string
  interval?: string
  imageUrl?: string
  rawJson?: string
}

export interface TrackFileRecord {
  id: number
  trackId: number
  quality: MusicQuality
  status: TrackFileStatus
  rawPath?: string
  finalPath?: string
  lyricsPath?: string
  coverPath?: string
  sizeBytes?: number
  sha256?: string
  taggedAt?: string
  error?: string
}

export interface PlayHistoryRecord extends MusicInfo {
  playEventId: number
  quality: MusicQuality
  playedAt: string
}
