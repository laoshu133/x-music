import fs from 'node:fs'
import path from 'node:path'
import { db } from '@/lib/db'
import { createJob } from '@/lib/jobs'
import type { MusicInfo, MusicQuality, OnlineSource, PlayHistoryRecord, TrackFileRecord, TrackFileStatus, TrackRecord } from '@/lib/types'

interface TrackRow {
  id: number
  source: OnlineSource
  songmid: string
  name: string
  singer: string
  album_name: string | null
  album_id: string | null
  interval: string | null
  image_url: string | null
  raw_json: string | null
}

interface TrackFileRow {
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

interface PlayHistoryRow extends TrackRow {
  play_event_id: number
  quality: MusicQuality
  played_at: string
}

const now = () => new Date().toISOString()

export const ensureTrack = (musicInfo: MusicInfo): TrackRecord => {
  const rawJson = JSON.stringify(musicInfo.raw ?? musicInfo)
  db.prepare(`
    INSERT INTO tracks (source, songmid, name, singer, album_name, album_id, interval, image_url, raw_json, updated_at)
    VALUES (@source, @songmid, @name, @singer, @albumName, @albumId, @interval, @imageUrl, @rawJson, @updatedAt)
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
    source: musicInfo.source,
    songmid: musicInfo.songmid,
    name: musicInfo.name,
    singer: musicInfo.singer,
    albumName: musicInfo.albumName ?? null,
    albumId: musicInfo.albumId ?? null,
    interval: musicInfo.interval ?? null,
    imageUrl: musicInfo.img ?? null,
    rawJson,
    updatedAt: now(),
  })

  return getTrack(musicInfo.source, musicInfo.songmid) ?? fail(`Unable to load track ${musicInfo.source}:${musicInfo.songmid}`)
}

export const getTrack = (source: OnlineSource, songmid: string): TrackRecord | undefined => {
  const row = db.prepare('SELECT * FROM tracks WHERE source = ? AND songmid = ?').get(source, songmid) as TrackRow | undefined
  return row ? mapTrack(row) : undefined
}

export const getReadyTrackFile = (source: OnlineSource, songmid: string, quality: MusicQuality): TrackFileRecord | undefined => {
  const row = db.prepare(`
    SELECT tf.*
    FROM track_files tf
    INNER JOIN tracks t ON t.id = tf.track_id
    WHERE t.source = ? AND t.songmid = ? AND tf.quality = ? AND tf.status = 'ready'
  `).get(source, songmid, quality) as TrackFileRow | undefined

  const record = row ? mapTrackFile(row) : undefined
  if (!record?.finalPath || !fs.existsSync(record.finalPath)) return undefined
  return record
}

export const getPlayableTrackFile = (source: OnlineSource, songmid: string, quality: MusicQuality): TrackFileRecord | undefined => {
  const row = db.prepare(`
    SELECT tf.*
    FROM track_files tf
    INNER JOIN tracks t ON t.id = tf.track_id
    WHERE t.source = ? AND t.songmid = ? AND tf.quality = ?
      AND tf.status IN ('ready', 'tagging', 'cached_raw', 'failed')
    ORDER BY
      CASE tf.status
        WHEN 'ready' THEN 0
        WHEN 'tagging' THEN 1
        WHEN 'cached_raw' THEN 2
        WHEN 'failed' THEN 3
        ELSE 3
      END
    LIMIT 1
  `).get(source, songmid, quality) as TrackFileRow | undefined

  const record = row ? mapTrackFile(row) : undefined
  if (record?.finalPath && fs.existsSync(record.finalPath)) return record
  if (record?.rawPath && fs.existsSync(record.rawPath)) return record
  return undefined
}

export const hasActiveTrackFile = (source: OnlineSource, songmid: string, qualities: MusicQuality[]): boolean => {
  const rows = db.prepare(`
    SELECT COUNT(*) AS count
    FROM track_files tf
    INNER JOIN tracks t ON t.id = tf.track_id
    WHERE t.source = @source
      AND t.songmid = @songmid
      AND tf.quality IN (${qualities.map((_, index) => `@quality${index}`).join(',')})
      AND tf.status IN ('resolving_url', 'streaming_and_caching')
  `).get({
    source,
    songmid,
    ...Object.fromEntries(qualities.map((quality, index) => [`quality${index}`, quality])),
  }) as { count: number }

  return rows.count > 0
}

export const upsertTrackFileStatus = (
  trackId: number,
  quality: MusicQuality,
  status: TrackFileStatus,
  fields: Partial<Pick<TrackFileRecord, 'rawPath' | 'finalPath' | 'sizeBytes' | 'sha256' | 'error'>> = {},
): TrackFileRecord => {
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
    trackId,
    quality,
    status,
    rawPath: fields.rawPath ?? null,
    finalPath: fields.finalPath ?? null,
    lyricsPath: null,
    coverPath: null,
    sizeBytes: fields.sizeBytes ?? null,
    sha256: fields.sha256 ?? null,
    taggedAt: null,
    error: fields.error ?? null,
    updatedAt: now(),
  })

  return getTrackFile(trackId, quality) ?? fail(`Unable to load track file ${trackId}:${quality}`)
}

export const getTrackFile = (trackId: number, quality: MusicQuality): TrackFileRecord | undefined => {
  const row = db.prepare('SELECT * FROM track_files WHERE track_id = ? AND quality = ?').get(trackId, quality) as
    | TrackFileRow
    | undefined
  return row ? mapTrackFile(row) : undefined
}

export const insertPlayEvent = (trackId: number, quality: MusicQuality, qqUin?: string): void => {
  db.prepare('INSERT INTO play_events (track_id, quality, qq_uin) VALUES (?, ?, ?)').run(trackId, quality, qqUin ?? null)
}

export const listPlayHistory = (limit = 50): PlayHistoryRecord[] => {
  const normalizedLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200)
  const rows = db.prepare(`
    SELECT
      pe.id AS play_event_id,
      pe.quality,
      pe.played_at,
      t.*
    FROM play_events pe
    INNER JOIN tracks t ON t.id = pe.track_id
    ORDER BY pe.played_at DESC, pe.id DESC
    LIMIT ?
  `).all(normalizedLimit) as PlayHistoryRow[]

  return rows.map(mapPlayHistory)
}

export const enqueueTagJob = (trackFile: TrackFileRecord, track: TrackRecord): void => {
  if (!trackFile.rawPath) return
  const existing = db.prepare(`
    SELECT id
    FROM jobs
    WHERE type = 'tag_track_file'
      AND status IN ('queued', 'running')
      AND json_extract(payload_json, '$.trackFileId') = ?
    LIMIT 1
  `).get(trackFile.id) as { id: number } | undefined
  if (existing) return

  createJob({
    type: 'tag_track_file',
    payload: {
      trackFileId: trackFile.id,
      rawPath: trackFile.rawPath,
      source: track.source,
      songmid: track.songmid,
      quality: trackFile.quality,
      title: track.name,
      artist: track.singer,
      album: track.albumName,
      albumId: track.albumId,
    },
  })
}

export const fileExtensionFromContentType = (contentType: string | null, fallbackUrl: string): string => {
  const mime = contentType?.split(';', 1)[0]?.trim().toLowerCase()
  if (mime === 'audio/flac' || mime === 'audio/x-flac') return '.flac'
  if (mime === 'audio/mpeg' || mime === 'audio/mp3') return '.mp3'
  if (mime === 'audio/mp4' || mime === 'audio/x-m4a') return '.m4a'
  if (mime === 'audio/ogg') return '.ogg'

  const pathname = safeUrlPathname(fallbackUrl)
  const ext = path.extname(pathname).toLowerCase()
  return ext && ext.length <= 8 ? ext : '.mp3'
}

const safeUrlPathname = (value: string): string => {
  try {
    return new URL(value).pathname
  } catch {
    return value
  }
}

const mapTrack = (row: TrackRow): TrackRecord => ({
  id: row.id,
  source: row.source,
  songmid: row.songmid,
  name: row.name,
  singer: row.singer,
  albumName: row.album_name ?? undefined,
  albumId: row.album_id ?? undefined,
  interval: row.interval ?? undefined,
  imageUrl: row.image_url ?? undefined,
  rawJson: row.raw_json ?? undefined,
})

const mapTrackFile = (row: TrackFileRow): TrackFileRecord => ({
  id: row.id,
  trackId: row.track_id,
  quality: row.quality,
  status: row.status,
  rawPath: row.raw_path ?? undefined,
  finalPath: row.final_path ?? undefined,
  lyricsPath: row.lyrics_path ?? undefined,
  coverPath: row.cover_path ?? undefined,
  sizeBytes: row.size_bytes ?? undefined,
  sha256: row.sha256 ?? undefined,
  taggedAt: row.tagged_at ?? undefined,
  error: row.error ?? undefined,
})

const mapPlayHistory = (row: PlayHistoryRow): PlayHistoryRecord => {
  const track = mapTrack(row)
  return {
    source: track.source,
    songmid: track.songmid,
    name: track.name,
    singer: track.singer,
    albumName: track.albumName,
    albumId: track.albumId,
    interval: track.interval,
    img: track.imageUrl,
    raw: parseRawJson(track.rawJson),
    playEventId: row.play_event_id,
    quality: row.quality,
    playedAt: row.played_at,
  }
}

const parseRawJson = (value?: string): unknown | undefined => {
  if (!value) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

const fail = (message: string): never => {
  throw new Error(message)
}
