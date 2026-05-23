import { db } from '@/lib/db'
import {
  claimNextJob,
  completeJob,
  createJob,
  failJob,
  requeueJob,
} from '@/lib/jobs'
import { refreshUmCrypto } from './um-crypto'

export interface RefreshUmCryptoJobPayload {
  reason: 'startup' | 'manual'
  scheduledAt: string
}

export function enqueueRefreshUmCryptoJob(input: { reason: RefreshUmCryptoJobPayload['reason'] }): void {
  const existing = db.prepare(`
    SELECT id
    FROM jobs
    WHERE type = 'refresh_um_crypto'
      AND status IN ('queued', 'running')
    LIMIT 1
  `).get() as { id: number } | undefined
  if (existing) return

  createJob<RefreshUmCryptoJobPayload>({
    type: 'refresh_um_crypto',
    payload: {
      reason: input.reason,
      scheduledAt: new Date().toISOString(),
    },
  })
}

export async function processOneRefreshUmCryptoJob(maxAttempts: number): Promise<boolean> {
  const job = claimNextJob<RefreshUmCryptoJobPayload>({
    type: 'refresh_um_crypto',
    maxAttempts,
  })
  if (!job) return false

  try {
    const result = await refreshUmCrypto()
    completeJob(job.id)
    console.log(`completed UM crypto refresh job ${job.id}: ${result.status} ${result.version} ${result.path}`)
  } catch (error) {
    if (job.attempts >= maxAttempts) {
      failJob(job.id, error)
      console.error(`failed UM crypto refresh job ${job.id}`, error)
    } else {
      requeueJob(job.id, error)
      console.warn(`requeued UM crypto refresh job ${job.id}`, error)
    }
  }

  return true
}
