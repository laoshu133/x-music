import { appConfig } from '@/lib/config'
import { db } from '@/lib/db'
import { cleanupResourceCache } from '@/lib/cache/resources'
import {
  createJob,
  claimNextJob,
  completeJob,
  ensureJobsTable,
  failJob,
  recoverStaleRunningJobs,
  requeueJob,
} from '@/lib/jobs'
import { processOneEmbySyncJob } from '@/lib/emby/sync-worker'
import { cleanupInboxFile } from '@/lib/tagging/cleanup'
import { createTaggingProvider } from '@/lib/tagging/provider'
import type { TagTrackFileJobPayload } from '@/lib/tagging/types'
import { fileURLToPath } from 'node:url'

const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000)
const maxAttempts = Number(process.env.WORKER_MAX_ATTEMPTS ?? 3)
const cleanupIntervalMs = Number(process.env.WORKER_CLEANUP_INTERVAL_MS ?? 24 * 60 * 60 * 1000)
const staleRunningJobSeconds = Number(process.env.WORKER_STALE_RUNNING_JOB_SECONDS ?? 15 * 60)

const taggingProvider = createTaggingProvider()

let stopping = false
let nextCleanupAt = 0

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

interface CleanupResourceCacheJobPayload {
  reason: 'scheduled'
  scheduledAt: string
}

function ensureCleanupResourceCacheJob(): void {
  const now = Date.now()
  if (now < nextCleanupAt) return
  const existing = db.prepare(`
    SELECT id
    FROM jobs
    WHERE type = 'cleanup_resource_cache'
      AND status IN ('queued', 'running')
    LIMIT 1
  `).get() as { id: number } | undefined
  if (!existing) {
    createJob<CleanupResourceCacheJobPayload>({
      type: 'cleanup_resource_cache',
      payload: {
        reason: 'scheduled',
        scheduledAt: new Date(now).toISOString(),
      },
    })
  }
  nextCleanupAt = now + cleanupIntervalMs
}

async function processCleanupResourceCacheJob(): Promise<boolean> {
  const job = claimNextJob<CleanupResourceCacheJobPayload>({
    type: 'cleanup_resource_cache',
    maxAttempts,
  })
  if (!job) return false

  try {
    const result = await cleanupResourceCache()
    completeJob(job.id)
    console.log(`completed resource cache cleanup job ${job.id}: deleted ${result.deleted} files (${result.bytes} bytes)`)
  } catch (error) {
    if (job.attempts >= maxAttempts) {
      failJob(job.id, error)
      console.error(`failed resource cache cleanup job ${job.id}`, error)
    } else {
      requeueJob(job.id, error)
      console.warn(`requeued resource cache cleanup job ${job.id}`, error)
    }
  }

  return true
}

interface WorkerTickProcessors {
  processTagJob?: () => Promise<boolean>
  processEmbySyncJob?: () => Promise<boolean>
  processCleanupResourceCacheJob?: () => Promise<boolean>
  scheduleCleanupResourceCacheJob?: boolean
}

export async function processWorkerTick(processors: WorkerTickProcessors = {}): Promise<boolean> {
  if (processors.scheduleCleanupResourceCacheJob !== false) ensureCleanupResourceCacheJob()
  const processedTagJob = await (processors.processTagJob ?? processTagJob)()
  const processedEmbySyncJob = await (processors.processEmbySyncJob ?? processEmbySyncJob)()
  const processedCleanupResourceCacheJob = await (
    processors.processCleanupResourceCacheJob ?? processCleanupResourceCacheJob
  )()
  return processedTagJob || processedEmbySyncJob || processedCleanupResourceCacheJob
}

async function main(): Promise<void> {
  ensureJobsTable()
  const recovered = recoverStaleRunningJobs({
    olderThanSeconds: staleRunningJobSeconds,
    maxAttempts,
  })

  console.log('XMusic worker started')
  console.log(`data dir: ${appConfig.dataDir}`)
  console.log(`poll interval: ${pollIntervalMs}ms`)
  if (recovered) console.log(`recovered ${recovered} stale running jobs`)

  while (!stopping) {
    const didWork = await processWorkerTick()
    if (!didWork) await sleep(pollIntervalMs)
  }
}

installShutdownHandler('SIGINT')
installShutdownHandler('SIGTERM')

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error('worker crashed', error)
    process.exitCode = 1
  })
}
