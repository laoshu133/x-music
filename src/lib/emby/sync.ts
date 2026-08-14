import { createJob } from '@/lib/jobs'
import { db } from '@/lib/db'
import { getAccountByUserId } from '@/lib/db/accounts'
import type { MusicInfo } from '@/lib/types'
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
      db.prepare(`UPDATE user_track_sync_requests SET status = 'queued', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND track_id = ?`).run(request.user_id, track.id)
    } else {
      db.prepare('DELETE FROM user_track_sync_requests WHERE user_id = ? AND track_id = ?').run(request.user_id, track.id)
    }
  }
}

function hasSourceWebdav(userId: string): boolean {
  return Boolean(embyConfigForAccount(getAccountByUserId(userId)).sourceWebdavDsn)
}
