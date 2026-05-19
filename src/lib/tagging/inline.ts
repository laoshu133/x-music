import { db } from '@/lib/db'
import { claimNextJob, completeJob, failJob, requeueJob } from '@/lib/jobs'
import { createTaggingProvider } from '@/lib/tagging/provider'
import type { TagTrackFileJobPayload } from '@/lib/tagging/types'

const provider = createTaggingProvider()
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
      const result = await provider.tagFile(job.payload)
      db.prepare(`
        UPDATE track_files
        SET status = 'ready',
            final_path = @finalPath,
            error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = @trackFileId
      `).run({
        finalPath: result.finalPath,
        trackFileId: job.payload.trackFileId,
      })
      completeJob(job.id)
    } catch (error) {
      if (job.attempts >= 3) {
        db.prepare(`
          UPDATE track_files
          SET status = 'failed',
              error = @error,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = @trackFileId
        `).run({
          error: error instanceof Error ? error.message : String(error),
          trackFileId: job.payload.trackFileId,
        })
        failJob(job.id, error)
      } else {
        requeueJob(job.id, error)
      }
    }
  }
}
