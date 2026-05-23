import { db } from '@/lib/db'
import {
  claimNextJob,
  completeJob,
  createJob,
  failJob,
  requeueJob,
} from '@/lib/jobs'
import { refreshUmCli } from './um-cli'

export interface RefreshUmCliJobPayload {
  reason: 'startup' | 'manual'
  scheduledAt: string
}

export function enqueueRefreshUmCliJob(input: { reason: RefreshUmCliJobPayload['reason'] }): void {
  const existing = db.prepare(`
    SELECT id
    FROM jobs
    WHERE type = 'refresh_um_cli'
      AND status IN ('queued', 'running')
    LIMIT 1
  `).get() as { id: number } | undefined
  if (existing) return

  createJob<RefreshUmCliJobPayload>({
    type: 'refresh_um_cli',
    payload: {
      reason: input.reason,
      scheduledAt: new Date().toISOString(),
    },
  })
}

export async function processOneRefreshUmCliJob(maxAttempts: number): Promise<boolean> {
  const job = claimNextJob<RefreshUmCliJobPayload>({
    type: 'refresh_um_cli',
    maxAttempts,
  })
  if (!job) return false

  try {
    const result = await refreshUmCli()
    completeJob(job.id)
    console.log(`completed UM CLI refresh job ${job.id}: ${result.status} ${result.tagName ?? ''} ${result.path}`)
  } catch (error) {
    if (job.attempts >= maxAttempts) {
      failJob(job.id, error)
      console.error(`failed UM CLI refresh job ${job.id}`, error)
    } else {
      requeueJob(job.id, error)
      console.warn(`requeued UM CLI refresh job ${job.id}`, error)
    }
  }

  return true
}
