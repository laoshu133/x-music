import { db } from './index'
import type { MusicInfo, MusicQuality } from '@/lib/types'

export type TrackFileStatus =
  | 'missing'
  | 'resolving'
  | 'streaming_and_caching'
  | 'cached_raw'
  | 'tagging'
  | 'ready'
  | 'failed'

export interface TrackRow {
  id: number
  source: string
  songmid: string
  name: string
  singer: string
  album_name: string | null
  album_id: string | null
  interval: string | null
  image_url: string | null
  raw_json: string | null
}

export interface TrackFileRow {
  id: number
  track_id: number
  quality: MusicQuality
  status: TrackFileStatus
  raw_path: string | null
  final_path: string | null
  lyrics_path: string | null
  cover_path: string | null
  size_bytes: number | null
  sha256: string | null
  tagged_at: string | null
  error: string | null
}

const now = () => new Date().toISOString()

export const upsertTrack = (music: MusicInfo): TrackRow => {
  db.prepare(`
    INSERT INTO tracks (source, songmid, name, singer, album_name, album_id, interval, image_url, raw_json, updated_at)
    VALUES (@source, @songmid, @name, @singer, @albumName, @albumId, @interval, @img, @rawJson, @updatedAt)
    ON CONFLICT(source, songmid) DO UPDATE SET
      name = excluded.name,
      singer = excluded.singer,
      album_name = excluded.album_name,
      album_id = excluded.album_id,
      interval = excluded.interval,
      image_url = excluded.image_url,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `).run({
    source: music.source,
    songmid: music.songmid,
    name: music.name,
    singer: music.singer,
    albumName: music.albumName ?? null,
    albumId: music.albumId ?? null,
    interval: music.interval ?? null,
    img: music.img ?? null,
    rawJson: music.raw == null ? null : JSON.stringify(music.raw),
    updatedAt: now(),
  })

  const row = db.prepare('SELECT * FROM tracks WHERE source = ? AND songmid = ?').get(music.source, music.songmid) as TrackRow | undefined
  if (!row) throw new Error('Failed to upsert track')
  return row
}

export const getTrackFile = (trackId: number, quality: MusicQuality): TrackFileRow | null => {
  return db.prepare('SELECT * FROM track_files WHERE track_id = ? AND quality = ?').get(trackId, quality) as TrackFileRow | undefined ?? null
}

export const upsertTrackFile = (input: {
  trackId: number
  quality: MusicQuality
  status: TrackFileStatus
  rawPath?: string | null
  finalPath?: string | null
  lyricsPath?: string | null
  coverPath?: string | null
  sizeBytes?: number | null
  sha256?: string | null
  taggedAt?: string | null
  error?: string | null
}): TrackFileRow => {
  db.prepare(`
    INSERT INTO track_files (track_id, quality, status, raw_path, final_path, lyrics_path, cover_path, size_bytes, sha256, tagged_at, error, updated_at)
    VALUES (@trackId, @quality, @status, @rawPath, @finalPath, @lyricsPath, @coverPath, @sizeBytes, @sha256, @taggedAt, @error, @updatedAt)
    ON CONFLICT(track_id, quality) DO UPDATE SET
      status = excluded.status,
      raw_path = COALESCE(excluded.raw_path, track_files.raw_path),
      final_path = COALESCE(excluded.final_path, track_files.final_path),
      lyrics_path = COALESCE(excluded.lyrics_path, track_files.lyrics_path),
      cover_path = COALESCE(excluded.cover_path, track_files.cover_path),
      size_bytes = COALESCE(excluded.size_bytes, track_files.size_bytes),
      sha256 = COALESCE(excluded.sha256, track_files.sha256),
      tagged_at = COALESCE(excluded.tagged_at, track_files.tagged_at),
      error = excluded.error,
      updated_at = excluded.updated_at
  `).run({
    trackId: input.trackId,
    quality: input.quality,
    status: input.status,
    rawPath: input.rawPath ?? null,
    finalPath: input.finalPath ?? null,
    lyricsPath: input.lyricsPath ?? null,
    coverPath: input.coverPath ?? null,
    sizeBytes: input.sizeBytes ?? null,
    sha256: input.sha256 ?? null,
    taggedAt: input.taggedAt ?? null,
    error: input.error ?? null,
    updatedAt: now(),
  })

  const row = getTrackFile(input.trackId, input.quality)
  if (!row) throw new Error('Failed to upsert track file')
  return row
}

export const recordPlayEvent = (trackId: number, quality: MusicQuality, qqUin?: string) => {
  db.prepare('INSERT INTO play_events (track_id, quality, qq_uin) VALUES (?, ?, ?)').run(trackId, quality, qqUin ?? null)
}
