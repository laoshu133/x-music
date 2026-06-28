import { db } from '@/lib/db'
import type { MusicInfo, MusicQuality, OnlineSource } from '@/lib/types'

const CACHE_PREFIX = 'music-url.unplayable.'
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000

type UnplayableRecord = {
  source: OnlineSource
  songmid: string
  quality?: MusicQuality
  reason: string
  expiresAt: string
}

export function getCachedUnplayableSong(musicInfo: Pick<MusicInfo, 'source' | 'songmid'>): UnplayableRecord | undefined {
  const songRecord = readRecord(cacheKey(musicInfo.source, musicInfo.songmid))
  if (songRecord) return songRecord
  return undefined
}

export function getCachedUnplayableQuality(
  musicInfo: Pick<MusicInfo, 'source' | 'songmid'>,
  quality: MusicQuality,
): UnplayableRecord | undefined {
  return readRecord(cacheKey(musicInfo.source, musicInfo.songmid, quality))
}

export function markUnplayableQuality(
  musicInfo: Pick<MusicInfo, 'source' | 'songmid'>,
  quality: MusicQuality,
  reason: string,
  ttlMs = DEFAULT_TTL_MS,
): void {
  writeRecord({
    source: musicInfo.source,
    songmid: musicInfo.songmid,
    quality,
    reason,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  })
}

export function markUnplayableSong(
  musicInfo: Pick<MusicInfo, 'source' | 'songmid'>,
  reason: string,
  ttlMs = DEFAULT_TTL_MS,
): void {
  writeRecord({
    source: musicInfo.source,
    songmid: musicInfo.songmid,
    reason,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  })
}

export function isRecentlyUnplayableSong(musicInfo: Pick<MusicInfo, 'source' | 'songmid'>): boolean {
  return getCachedUnplayableSong(musicInfo) !== undefined
}

function readRecord(key: string): UnplayableRecord | undefined {
  const row = db.prepare('SELECT value_json AS valueJson FROM app_settings WHERE key = ?').get(key) as { valueJson?: string } | undefined
  if (!row?.valueJson) return undefined
  try {
    const record = JSON.parse(row.valueJson) as UnplayableRecord
    if (!record.expiresAt || Date.parse(record.expiresAt) <= Date.now()) {
      db.prepare('DELETE FROM app_settings WHERE key = ?').run(key)
      return undefined
    }
    return record
  } catch {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key)
    return undefined
  }
}

function writeRecord(record: UnplayableRecord): void {
  db.prepare(`
    INSERT INTO app_settings (key, value_json, updated_at)
    VALUES (@key, @valueJson, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    key: cacheKey(record.source, record.songmid, record.quality),
    valueJson: JSON.stringify(record),
  })
}

function cacheKey(source: OnlineSource, songmid: string, quality?: MusicQuality): string {
  return `${CACHE_PREFIX}${source}.${songmid}${quality ? `.${quality}` : ''}`
}
