import { appConfig } from '@/lib/config'
import { db } from '@/lib/db'
import {
  claimNextJob,
  completeJob,
  ensureJobsTable,
  failJob,
  requeueJob,
} from '@/lib/jobs'
import { processOneEmbySyncJob } from '@/lib/emby/sync-worker'
import { cleanupInboxFile } from '@/lib/tagging/cleanup'
import { createTaggingProvider } from '@/lib/tagging/provider'
import type { TagTrackFileJobPayload } from '@/lib/tagging/types'

const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000)
const maxAttempts = Number(process.env.WORKER_MAX_ATTEMPTS ?? 3)

const taggingProvider = createTaggingProvider()

let stopping = false

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function installShutdownHandler(signal: NodeJS.Signals): void {
  process.on(signal, () => {
    stopping = true
    console.log(`received ${signal}, stopping worker after current job`)
  })
}

async function processTagJob(): Promise<boolean> {
  const job = claimNextJob<TagTrackFileJobPayload>({
    type: 'tag_track_file',
    maxAttempts,
  })

  if (!job) return false

  console.log(`claimed tag job ${job.id} for ${job.payload.rawPath}`)

  try {
    const result = await taggingProvider.tagFile(job.payload)
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
    completeJob(job.id)
    console.log(`completed tag job ${job.id}: ${result.finalPath}`)
  } catch (error) {
    if (job.attempts >= maxAttempts) {
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
      console.error(`failed tag job ${job.id}`, error)
    } else {
      requeueJob(job.id, error)
      console.warn(`requeued tag job ${job.id}`, error)
    }
  }

  return true
}

async function processEmbySyncJob(): Promise<boolean> {
  return processOneEmbySyncJob(maxAttempts)
}

async function main(): Promise<void> {
  ensureJobsTable()

  console.log('XMusic worker started')
  console.log(`data dir: ${appConfig.dataDir}`)
  console.log(`poll interval: ${pollIntervalMs}ms`)

  while (!stopping) {
    const didWork = await processTagJob() || await processEmbySyncJob()
    if (!didWork) await sleep(pollIntervalMs)
  }
}

installShutdownHandler('SIGINT')
installShutdownHandler('SIGTERM')

main().catch((error) => {
  console.error('worker crashed', error)
  process.exitCode = 1
})
