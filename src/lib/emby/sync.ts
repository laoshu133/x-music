import { createJob } from '@/lib/jobs'
import { db } from '@/lib/db'
import type { MusicInfo } from '@/lib/types'

export interface SyncEmbyTrackJobPayload {
  source: 'tx'
  songmid: string
  playlistId?: string
  musicInfo: MusicInfo
  favorite?: boolean
  embyUserId?: string
}

export function enqueueEmbyTrackSync(input: SyncEmbyTrackJobPayload): void {
  const existing = db.prepare(`
    SELECT id
    FROM jobs
    WHERE type = 'sync_emby_track'
      AND status IN ('queued', 'running')
      AND json_extract(payload_json, '$.source') = @source
      AND json_extract(payload_json, '$.songmid') = @songmid
    LIMIT 1
  `).get({
    source: input.source,
    songmid: input.songmid,
  }) as { id: number } | undefined
  if (existing) return

  createJob({
    type: 'sync_emby_track',
    payload: input,
  })
}
