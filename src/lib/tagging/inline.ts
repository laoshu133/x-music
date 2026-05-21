import { db } from '@/lib/db'
import { claimNextJob, completeJob, failJob, requeueJob } from '@/lib/jobs'
import { enqueueEmbyTrackSync } from '@/lib/emby/sync'
import { processOneEmbySyncJob } from '@/lib/emby/sync-worker'
import { cleanupInboxFile } from '@/lib/tagging/cleanup'
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
            lyrics_path = COALESCE(@lyricsPath, lyrics_path),
            cover_path = COALESCE(@coverPath, cover_path),
            tagged_at = CURRENT_TIMESTAMP,
            error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = @trackFileId
      `).run({
        finalPath: result.finalPath,
        lyricsPath: result.lyricsPath ?? null,
        coverPath: result.coverPath ?? null,
        trackFileId: job.payload.trackFileId,
      })
      await cleanupInboxFile({
        trackFileId: job.payload.trackFileId,
        rawPath: job.payload.rawPath,
        finalPath: result.finalPath,
      }).catch((cleanupError: unknown) => {
        console.warn(
          `failed to clean inbox file for track file ${job.payload.trackFileId}: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
        )
      })
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
      })
      completeJob(job.id)
      await processOneEmbySyncJob().catch((error: unknown) => {
        console.warn('failed inline Emby sync', error)
      })
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
