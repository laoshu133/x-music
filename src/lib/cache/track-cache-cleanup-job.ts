import { cleanupTrackCache } from '@/lib/cache/track-cache-cleanup'
import { db } from '@/lib/db'
import { claimJobById, claimNextJob, completeJob, createJob, failJob, requeueJob } from '@/lib/jobs'

export interface CleanupTrackCacheJobPayload {
  reason: 'scheduled'
  scheduledAt: string
}

export function enqueueCleanupTrackCacheJob(input: CleanupTrackCacheJobPayload = {
  reason: 'scheduled',
  scheduledAt: new Date().toISOString(),
}): void {
  const existing = db.prepare(`
    SELECT id
    FROM jobs
    WHERE type = 'cleanup_track_cache'
      AND status IN ('queued', 'running')
    LIMIT 1
  `).get() as { id: number } | undefined
  if (existing) return

  createJob<CleanupTrackCacheJobPayload>({
    type: 'cleanup_track_cache',
    payload: input,
  })
}

export async function processOneCleanupTrackCacheJob(maxAttempts = 3): Promise<boolean> {
  const job = claimNextJob<CleanupTrackCacheJobPayload>({
    type: 'cleanup_track_cache',
    maxAttempts,
  })
  if (!job) return false

  try {
    const result = await cleanupTrackCache()
    completeJob(job.id)
    console.log(`completed track cache cleanup job ${job.id}: deleted ${result.deleted} files (${result.bytes} bytes)`)
  } catch (error) {
    if (job.attempts >= maxAttempts) {
      failJob(job.id, error)
      console.error(`failed track cache cleanup job ${job.id}`, error)
    } else {
      requeueJob(job.id, error, maxAttempts)
      console.warn(`requeued track cache cleanup job ${job.id}`, error)
    }
  }

  return true
}

export async function processCleanupTrackCacheJobById(jobId: number): Promise<void> {
  const maxAttempts = Number(process.env.WORKER_MAX_ATTEMPTS ?? 3)
  const job = claimJobById<CleanupTrackCacheJobPayload>({
    id: jobId,
    type: 'cleanup_track_cache',
    maxAttempts,
  })
  if (!job) return

  try {
    const result = await cleanupTrackCache()
    completeJob(job.id)
    console.log(`completed track cache cleanup job ${job.id}: deleted ${result.deleted} files (${result.bytes} bytes)`)
  } catch (error) {
    if (job.attempts >= maxAttempts) {
      failJob(job.id, error)
    } else {
      requeueJob(job.id, error, maxAttempts)
    }
    throw error
  }
}
