import { claimNextJob, completeJob, failJob, requeueJob } from '@/lib/jobs'
import { enqueueEmbyTrackSync } from '@/lib/emby/sync'
import { processOneEmbySyncJob } from '@/lib/emby/sync-worker'
import { failTagTrackFile, tagTrackFile } from '@/lib/tagging/job'
import type { TagTrackFileJobPayload } from '@/lib/tagging/types'

let draining = false

export function triggerInlineTagging(): void {
  if (draining) return
  draining = true
  void drainTaggingJobs().finally(() => {
    draining = false
  })
}

async function drainTaggingJobs(): Promise<void> {
  for (;;) {
    const job = claimNextJob<TagTrackFileJobPayload>({ type: 'tag_track_file', maxAttempts: 3 })
    if (!job) return

    try {
      await tagTrackFile(job.payload)
      enqueueEmbyTrackSync({
        source: job.payload.source,
        songmid: job.payload.songmid,
        musicInfo: {
          source: job.payload.source,
          songmid: job.payload.songmid,
          name: job.payload.title ?? job.payload.songmid,
          singer: job.payload.artist ?? '',
          albumName: job.payload.album,
          albumId: job.payload.albumId,
        },
        qqUin: job.payload.qqUin,
      })
      completeJob(job.id)
      await processOneEmbySyncJob().catch((error: unknown) => {
        console.warn('failed inline Emby sync', error)
      })
    } catch (error) {
      if (job.attempts >= 3) {
        failTagTrackFile(job.payload, error)
        failJob(job.id, error)
      } else {
        requeueJob(job.id, error)
      }
    }
  }
}
