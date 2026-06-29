import { enqueueEmbyTrackSync } from '@/lib/emby/sync'
import { db } from '@/lib/db'
import { claimJobById, completeJob, failJob, requeueJob } from '@/lib/jobs'
import { cleanupInboxFile } from '@/lib/tagging/cleanup'
import { createTaggingProvider } from '@/lib/tagging/provider'
import type { TagTrackFileJobPayload } from '@/lib/tagging/types'

const provider = createTaggingProvider()

export async function tagTrackFile(payload: TagTrackFileJobPayload): Promise<void> {
  const result = await provider.tagFile(payload)
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
    trackFileId: payload.trackFileId,
  })
  await cleanupInboxFile({
    trackFileId: payload.trackFileId,
    rawPath: payload.rawPath,
    finalPath: result.finalPath,
  }).catch((cleanupError: unknown) => {
    console.warn(
      `failed to clean inbox file for track file ${payload.trackFileId}: ${
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      }`,
    )
  })
}

export function failTagTrackFile(payload: Pick<TagTrackFileJobPayload, 'trackFileId'>, error: unknown): void {
  db.prepare(`
    UPDATE track_files
    SET status = 'failed',
        error = @error,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @trackFileId
  `).run({
    error: error instanceof Error ? error.message : String(error),
    trackFileId: payload.trackFileId,
  })
}

export async function processTagTrackFileJobById(jobId: number): Promise<void> {
  const maxAttempts = Number(process.env.WORKER_MAX_ATTEMPTS ?? 3)
  const job = claimJobById<TagTrackFileJobPayload>({
    id: jobId,
    type: 'tag_track_file',
    maxAttempts,
  })
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
  } catch (error) {
    if (job.attempts >= maxAttempts) {
      failTagTrackFile(job.payload, error)
      failJob(job.id, error)
    } else {
      requeueJob(job.id, error, maxAttempts)
    }
    throw error
  }
}
