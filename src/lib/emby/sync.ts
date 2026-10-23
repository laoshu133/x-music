import { createJob } from '@/lib/jobs'
import { db } from '@/lib/db'
import { getAccountByUserId } from '@/lib/db/accounts'
import { appConfig } from '@/lib/config'
import { isPlayableAudioFileName } from '@/lib/cache/store'
import { logServiceEvent } from '@/lib/request-log'
import type { MusicInfo } from '@/lib/types'
import path from 'node:path'
import fs from 'node:fs'
import { embyConfigForAccount } from './config'

export interface SyncEmbyTrackJobPayload {
  source: 'tx'
  songmid: string
  playlistId?: string
  musicInfo: MusicInfo
  allowCachedQualityFallback?: boolean
}

export function requestUserTrackSync(userId: string, trackId: number, reason: string): boolean {
  if (!hasSourceWebdav(userId)) {
    db.prepare('DELETE FROM user_track_sync_requests WHERE user_id = ? AND track_id = ?').run(userId, trackId)
    return false
  }
  if (hasActiveEmbySyncJob(userId, trackId)) {
    db.prepare('DELETE FROM user_track_sync_requests WHERE user_id = ? AND track_id = ?').run(userId, trackId)
    return true
  }
  db.prepare(`
    INSERT INTO user_track_sync_requests (user_id, track_id, reason, status, updated_at)
    VALUES (?, ?, ?, 'pending', CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, track_id) DO UPDATE SET reason = excluded.reason, status = 'pending', updated_at = CURRENT_TIMESTAMP
  `).run(userId, trackId, reason)
  return true
}

export function enqueueEmbyTrackSync(userId: string, input: SyncEmbyTrackJobPayload): boolean {
  if (!hasSourceWebdav(userId)) return false
  const existing = db.prepare(`
    SELECT id FROM jobs
    WHERE type = 'sync_emby_track' AND user_id = @userId
      AND status IN ('queued', 'running')
      AND json_extract(payload_json, '$.source') = @source
      AND json_extract(payload_json, '$.songmid') = @songmid
    LIMIT 1
  `).get({ userId, source: input.source, songmid: input.songmid }) as { id: number } | undefined
  if (existing) return true
  createJob({ type: 'sync_emby_track', userId, payload: input })
  return true
}

export function enqueuePendingEmbyTrackSyncs(musicInfo: MusicInfo): void {
  const track = db.prepare('SELECT id FROM tracks WHERE source = ? AND songmid = ?').get(musicInfo.source, musicInfo.songmid) as { id: number } | undefined
  if (!track) return
  const requests = db.prepare(`SELECT user_id FROM user_track_sync_requests WHERE track_id = ? AND status = 'pending'`).all(track.id) as Array<{ user_id: string }>
  for (const request of requests) {
    const queued = enqueueEmbyTrackSync(request.user_id, { source: 'tx', songmid: musicInfo.songmid, musicInfo })
    if (queued) {
      db.prepare('DELETE FROM user_track_sync_requests WHERE user_id = ? AND track_id = ?').run(request.user_id, track.id)
    } else {
      db.prepare('DELETE FROM user_track_sync_requests WHERE user_id = ? AND track_id = ?').run(request.user_id, track.id)
    }
  }
}

export interface EmbySyncReconcileResult {
  total: number
  enqueued: number
  linkedActive: number
  droppedNoWebdav: number
  droppedNoCache: number
}

export interface FailedEmbySyncReplayResult {
  failedCombinations: number
  eligible: number
  enqueued: number
  skippedActive: number
  skippedNoWebdav: number
  skippedNoCache: number
  skippedInvalidPayload: number
}

export function reconcilePendingEmbyTrackSyncs(options: {
  userId?: string
  dryRun?: boolean
} = {}): EmbySyncReconcileResult {
  const rows = db.prepare(`
    SELECT
      r.user_id AS userId,
      r.track_id AS trackId,
      r.status,
      t.id,
      t.source,
      t.songmid,
      t.name,
      t.singer,
      t.album_name AS albumName,
      t.album_id AS albumId,
      t.interval,
      t.image_url AS imageUrl,
      t.raw_json AS rawJson
    FROM user_track_sync_requests r
    INNER JOIN tracks t ON t.id = r.track_id
    WHERE (@userId IS NULL OR r.user_id = @userId)
    ORDER BY r.updated_at ASC, r.user_id ASC, r.track_id ASC
  `).all({ userId: options.userId ?? null }) as Array<{
    userId: string
    trackId: number
    status: string
    id: number
    source: 'tx'
    songmid: string
    name: string
    singer: string
    albumName: string | null
    albumId: string | null
    interval: string | null
    imageUrl: string | null
    rawJson: string | null
  }>
  const result: EmbySyncReconcileResult = {
    total: rows.length,
    enqueued: 0,
    linkedActive: 0,
    droppedNoWebdav: 0,
    droppedNoCache: 0,
  }

  for (const row of rows) {
    const account = getAccountByUserId(row.userId)
    if (!account || !embyConfigForAccount(account).sourceWebdavDsn) {
      result.droppedNoWebdav += 1
      if (!options.dryRun) deleteSyncRequest(row.userId, row.trackId)
      continue
    }

    if (hasActiveEmbySyncJob(row.userId, row.trackId)) {
      result.linkedActive += 1
      if (!options.dryRun) deleteSyncRequest(row.userId, row.trackId)
      continue
    }

    if (!hasReadyLocalMediaForWebdav(row.id)) {
      result.droppedNoCache += 1
      if (!options.dryRun) deleteSyncRequest(row.userId, row.trackId)
      continue
    }

    if (options.dryRun) {
      result.enqueued += 1
      continue
    }
    const musicInfo = rowToMusicInfo(row)
    if (enqueueEmbyTrackSync(row.userId, {
      source: row.source,
      songmid: row.songmid,
      musicInfo,
    })) {
      result.enqueued += 1
      deleteSyncRequest(row.userId, row.trackId)
    }
  }

  if (!options.dryRun && result.total > 0) {
    logServiceEvent('emby_sync_requests_reconciled', { ...result })
  }
  return result
}

export function replayFailedEmbyTrackSyncs(options: {
  userId?: string
  dryRun?: boolean
  limit?: number
} = {}): FailedEmbySyncReplayResult {
  const dryRun = options.dryRun ?? true
  const limit = Math.max(1, Math.trunc(options.limit ?? 25))
  const rows = db.prepare(`
    WITH ranked AS (
      SELECT
        j.*,
        ROW_NUMBER() OVER (
          PARTITION BY j.user_id, json_extract(j.payload_json, '$.source'), json_extract(j.payload_json, '$.songmid')
          ORDER BY j.id DESC
        ) AS rank
      FROM jobs j
      WHERE j.type = 'sync_emby_track'
        AND j.user_id IS NOT NULL
        AND (@userId IS NULL OR j.user_id = @userId)
    )
    SELECT id, user_id AS userId, payload_json AS payloadJson
    FROM ranked
    WHERE rank = 1 AND status = 'failed'
    ORDER BY id ASC
  `).all({ userId: options.userId ?? null }) as Array<{
    id: number
    userId: string
    payloadJson: string
  }>
  const result: FailedEmbySyncReplayResult = {
    failedCombinations: rows.length,
    eligible: 0,
    enqueued: 0,
    skippedActive: 0,
    skippedNoWebdav: 0,
    skippedNoCache: 0,
    skippedInvalidPayload: 0,
  }

  for (const row of rows) {
    if (result.eligible >= limit) break
    const payload = parseFailedSyncPayload(row.payloadJson)
    if (!payload) {
      result.skippedInvalidPayload += 1
      continue
    }
    const account = getAccountByUserId(row.userId)
    if (!account || !embyConfigForAccount(account).sourceWebdavDsn) {
      result.skippedNoWebdav += 1
      continue
    }
    const track = db.prepare(`
      SELECT
        id,
        source,
        songmid,
        name,
        singer,
        album_name AS albumName,
        album_id AS albumId,
        interval,
        image_url AS imageUrl,
        raw_json AS rawJson
      FROM tracks
      WHERE source = ? AND songmid = ?
    `).get(payload.source, payload.songmid) as SyncReplayTrackRow | undefined
    if (!track) {
      result.skippedInvalidPayload += 1
      continue
    }
    if (hasActiveEmbySyncJob(row.userId, track.id)) {
      result.skippedActive += 1
      continue
    }
    if (!hasReadyLocalMediaForWebdav(track.id)) {
      result.skippedNoCache += 1
      continue
    }

    result.eligible += 1
    if (dryRun) continue
    const musicInfo = rowToMusicInfo(track)
    if (enqueueEmbyTrackSync(row.userId, {
      source: 'tx',
      songmid: track.songmid,
      musicInfo,
    })) {
      result.enqueued += 1
    }
  }

  if (!dryRun) {
    logServiceEvent('failed_emby_sync_jobs_replayed', { ...result })
  }
  return result
}

function hasSourceWebdav(userId: string): boolean {
  return Boolean(embyConfigForAccount(getAccountByUserId(userId)).sourceWebdavDsn)
}

function hasActiveEmbySyncJob(userId: string, trackId: number): boolean {
  const row = db.prepare(`
    SELECT t.songmid
    FROM tracks t
    WHERE t.id = ?
  `).get(trackId) as { songmid: string } | undefined
  if (!row) return false
  return Boolean(db.prepare(`
    SELECT 1
    FROM jobs
    WHERE type = 'sync_emby_track'
      AND user_id = ?
      AND status IN ('queued', 'running')
      AND json_extract(payload_json, '$.songmid') = ?
    LIMIT 1
  `).get(userId, row.songmid))
}

function hasReadyLocalMediaForWebdav(trackId: number): boolean {
  const rows = db.prepare(`
    SELECT final_path AS finalPath
    FROM track_files
    WHERE track_id = ? AND status = 'ready' AND final_path IS NOT NULL
  `).all(trackId) as Array<{ finalPath: string }>
  const musicRoot = path.resolve(appConfig.musicDir)
  return rows.some(row => {
    const candidate = path.resolve(row.finalPath)
    const relative = path.relative(musicRoot, candidate)
    return Boolean(relative)
      && !relative.startsWith('..')
      && !path.isAbsolute(relative)
      && isPlayableAudioFileName(candidate)
      && fs.existsSync(candidate)
  })
}

function deleteSyncRequest(userId: string, trackId: number): void {
  db.prepare('DELETE FROM user_track_sync_requests WHERE user_id = ? AND track_id = ?').run(userId, trackId)
}

interface SyncReplayTrackRow {
  id: number
  source: 'tx'
  songmid: string
  name: string
  singer: string
  albumName: string | null
  albumId: string | null
  interval: string | null
  imageUrl: string | null
  rawJson: string | null
}

function parseFailedSyncPayload(payloadJson: string): Pick<SyncEmbyTrackJobPayload, 'source' | 'songmid'> | undefined {
  try {
    const payload = JSON.parse(payloadJson) as Partial<SyncEmbyTrackJobPayload>
    if (payload.source !== 'tx' || typeof payload.songmid !== 'string' || !payload.songmid.trim()) return undefined
    return { source: 'tx', songmid: payload.songmid }
  } catch {
    return undefined
  }
}

function rowToMusicInfo(row: {
  source: 'tx'
  songmid: string
  name: string
  singer: string
  albumName: string | null
  albumId: string | null
  interval: string | null
  imageUrl: string | null
  rawJson: string | null
}): MusicInfo {
  let raw: unknown
  if (row.rawJson) {
    try {
      raw = JSON.parse(row.rawJson)
    } catch {
      raw = undefined
    }
  }
  return {
    source: row.source,
    songmid: row.songmid,
    name: row.name,
    singer: row.singer,
    albumName: row.albumName ?? undefined,
    albumId: row.albumId ?? undefined,
    interval: row.interval ?? undefined,
    img: row.imageUrl ?? undefined,
    raw,
  }
}
