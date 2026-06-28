import { cleanupResourceCache } from '@/lib/cache/resources'
import { db } from '@/lib/db'
import { claimJobById, claimNextJob, completeJob, createJob, failJob, requeueJob } from '@/lib/jobs'

export interface CleanupResourceCacheJobPayload {
  reason: 'scheduled'
  scheduledAt: string
}

export function enqueueCleanupResourceCacheJob(input: CleanupResourceCacheJobPayload = {
  reason: 'scheduled',
  scheduledAt: new Date().toISOString(),
}): void {
  const existing = db.prepare(`
    SELECT id
    FROM jobs
    WHERE type = 'cleanup_resource_cache'
      AND status IN ('queued', 'running')
    LIMIT 1
  `).get() as { id: number } | undefined
  if (existing) return

  const job = createJob<CleanupResourceCacheJobPayload>({
    type: 'cleanup_resource_cache',
    payload: input,
  })
  void import('@/lib/trigger/dispatch').then(({ dispatchJob }) => {
    void dispatchJob(job).catch((error: unknown) => {
      console.warn(`failed to dispatch resource cache cleanup job ${job.id}`, error)
    })
  })
}

export async function processOneCleanupResourceCacheJob(maxAttempts = 3): Promise<boolean> {
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

export async function processCleanupResourceCacheJobById(jobId: number): Promise<void> {
  const maxAttempts = Number(process.env.WORKER_MAX_ATTEMPTS ?? 3)
  const job = claimJobById<CleanupResourceCacheJobPayload>({
    id: jobId,
    type: 'cleanup_resource_cache',
  })
  if (!job) return

  try {
    const result = await cleanupResourceCache()
    completeJob(job.id)
    console.log(`completed resource cache cleanup job ${job.id}: deleted ${result.deleted} files (${result.bytes} bytes)`)
  } catch (error) {
    if (job.attempts >= maxAttempts) {
      failJob(job.id, error)
    } else {
      requeueJob(job.id, error)
    }
    throw error
  }
}
