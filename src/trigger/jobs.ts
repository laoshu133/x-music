import { schedules, task } from '@trigger.dev/sdk/v3'
import { enqueueCleanupResourceCacheJob } from '@/lib/cache/cleanup-job'
import type { JobType } from '@/lib/jobs'
import { runJobByIdThroughConfiguredRunner } from '@/lib/jobs/run'
import { triggerTaskIds } from '@/lib/trigger/dispatch'

interface JobPayload {
  jobId: number
  type: JobType
}

const retry = {
  maxAttempts: Number(process.env.WORKER_MAX_ATTEMPTS ?? 3),
  factor: 2,
  minTimeoutInMs: 30_000,
  maxTimeoutInMs: 180_000,
  randomize: false,
}

export const refreshUmCryptoTask = task({
  id: triggerTaskIds.refreshUmCrypto,
  retry,
  queue: {
    name: 'xmusic-refresh-um-crypto',
    concurrencyLimit: 1,
  },
  run: async (payload: JobPayload) => {
    await runJobByIdThroughConfiguredRunner(payload)
  },
})

export const archiveTrackTask = task({
  id: triggerTaskIds.archiveTrack,
  retry,
  queue: {
    name: 'xmusic-archive-track',
    concurrencyLimit: 2,
  },
  run: async (payload: JobPayload) => {
    await runJobByIdThroughConfiguredRunner(payload)
  },
})

export const tagTrackFileTask = task({
  id: triggerTaskIds.tagTrackFile,
  retry,
  queue: {
    name: 'xmusic-tag-track-file',
    concurrencyLimit: 1,
  },
  run: async (payload: JobPayload) => {
    await runJobByIdThroughConfiguredRunner(payload)
  },
})

export const syncEmbyTrackTask = task({
  id: triggerTaskIds.syncEmbyTrack,
  retry,
  queue: {
    name: 'xmusic-sync-emby-track',
    concurrencyLimit: 1,
  },
  maxDuration: 300,
  run: async (payload: JobPayload) => {
    await runJobByIdThroughConfiguredRunner(payload)
  },
})

export const cleanupResourceCacheTask = task({
  id: triggerTaskIds.cleanupResourceCache,
  retry,
  queue: {
    name: 'xmusic-cleanup-resource-cache',
    concurrencyLimit: 1,
  },
  run: async (payload: JobPayload) => {
    await runJobByIdThroughConfiguredRunner(payload)
  },
})

export const scheduledCleanupResourceCacheTask = schedules.task({
  id: 'xmusic.scheduled-cleanup-resource-cache',
  cron: process.env.TRIGGER_CLEANUP_RESOURCE_CACHE_CRON ?? '0 3 * * *',
  run: async () => {
    enqueueCleanupResourceCacheJob({
      reason: 'scheduled',
      scheduledAt: new Date().toISOString(),
    })
  },
})
