import type { MusicQuality, OnlineSource } from '@/lib/types'

export interface TagTrackFileJobPayload {
  trackFileId: number
  rawPath: string
  source: OnlineSource
  songmid: string
  quality: MusicQuality
  title?: string
  artist?: string
  album?: string
  albumId?: string
}
