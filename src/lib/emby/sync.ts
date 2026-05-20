import { createJob } from '@/lib/jobs'
import type { MusicInfo } from '@/lib/types'

export interface SyncEmbyTrackJobPayload {
  source: 'tx'
  songmid: string
  playlistId?: string
  musicInfo: MusicInfo
}

export function enqueueEmbyTrackSync(input: SyncEmbyTrackJobPayload): void {
  createJob({
    type: 'sync_emby_track',
    payload: input,
  })
}
