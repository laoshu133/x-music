import { createJob } from '@/lib/jobs'
import { db } from '@/lib/db'
import type { MusicInfo } from '@/lib/types'

export interface SyncEmbyTrackJobPayload {
  source: 'tx'
  songmid: string
  playlistId?: string
  musicInfo: MusicInfo
  allowCachedQualityFallback?: boolean
}

export function requestUserTrackSync(userId: string, trackId: number, reason: string): void {
  db.prepare(`
    INSERT INTO user_track_sync_requests (user_id, track_id, reason, status, updated_at)
    VALUES (?, ?, ?, 'pending', CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, track_id) DO UPDATE SET reason = excluded.reason, status = 'pending', updated_at = CURRENT_TIMESTAMP
  `).run(userId, trackId, reason)
}

export function enqueueEmbyTrackSync(userId: string, input: SyncEmbyTrackJobPayload): void {
  const existing = db.prepare(`
    SELECT id FROM jobs
    WHERE type = 'sync_emby_track' AND user_id = @userId
      AND status IN ('queued', 'running')
      AND json_extract(payload_json, '$.source') = @source
      AND json_extract(payload_json, '$.songmid') = @songmid
    LIMIT 1
  `).get({ userId, source: input.source, songmid: input.songmid }) as { id: number } | undefined
  if (existing) return
  createJob({ type: 'sync_emby_track', userId, payload: input })
}

export function enqueuePendingEmbyTrackSyncs(musicInfo: MusicInfo): void {
  const track = db.prepare('SELECT id FROM tracks WHERE source = ? AND songmid = ?').get(musicInfo.source, musicInfo.songmid) as { id: number } | undefined
  if (!track) return
  const requests = db.prepare(`SELECT user_id FROM user_track_sync_requests WHERE track_id = ? AND status = 'pending'`).all(track.id) as Array<{ user_id: string }>
  for (const request of requests) {
    enqueueEmbyTrackSync(request.user_id, { source: 'tx', songmid: musicInfo.songmid, musicInfo })
    db.prepare(`UPDATE user_track_sync_requests SET status = 'queued', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND track_id = ?`).run(request.user_id, track.id)
  }
}
