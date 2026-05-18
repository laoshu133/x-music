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

export interface ResolvedMusicUrl {
  url: string
  quality: MusicQuality
  source: OnlineSource
  songmid: string
  expiresAt?: Date
}
