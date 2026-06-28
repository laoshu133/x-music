import { db } from '@/lib/db'
import {
  claimJobById,
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

  const job = createJob<RefreshUmCryptoJobPayload>({
    type: 'refresh_um_crypto',
    payload: {
      reason: input.reason,
      scheduledAt: new Date().toISOString(),
    },
  })
  void import('@/lib/trigger/dispatch').then(({ dispatchJob }) => {
    void dispatchJob(job).catch((error: unknown) => {
      console.warn(`failed to dispatch UM crypto refresh job ${job.id}`, error)
    })
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

export async function processRefreshUmCryptoJobById(jobId: number): Promise<void> {
  const maxAttempts = Number(process.env.WORKER_MAX_ATTEMPTS ?? 3)
  const job = claimJobById<RefreshUmCryptoJobPayload>({
    id: jobId,
    type: 'refresh_um_crypto',
  })
  if (!job) return

  try {
    const result = await refreshUmCrypto()
    completeJob(job.id)
    console.log(`completed UM crypto refresh job ${job.id}: ${result.status} ${result.version} ${result.path}`)
  } catch (error) {
    if (job.attempts >= maxAttempts) {
      failJob(job.id, error)
    } else {
      requeueJob(job.id, error)
    }
    throw error
  }
}
