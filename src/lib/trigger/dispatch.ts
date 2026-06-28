import { tasks } from '@trigger.dev/sdk/v3'
import type { JobRow, JobType } from '@/lib/jobs'
import type {
  archiveTrackTask,
  cleanupTrackCacheTask,
  cleanupResourceCacheTask,
  refreshUmCryptoTask,
  syncEmbyTrackTask,
  tagTrackFileTask,
} from '@/trigger/jobs'

export const triggerTaskIds = {
  archiveTrack: 'xmusic.archive-track',
  cleanupResourceCache: 'xmusic.cleanup-resource-cache',
  cleanupTrackCache: 'xmusic.cleanup-track-cache',
  refreshUmCrypto: 'xmusic.refresh-um-crypto',
  syncEmbyTrack: 'xmusic.sync-emby-track',
  tagTrackFile: 'xmusic.tag-track-file',
} as const

export async function dispatchJob(job: Pick<JobRow, 'id' | 'type'>): Promise<void> {
  if (!process.env.TRIGGER_SECRET_KEY) return

  const payload = { jobId: job.id, type: job.type as JobType }
  const options = {
    idempotencyKey: `xmusic-job-${job.id}`,
    tags: [`xmusic-job:${job.id}`, `xmusic-type:${job.type}`],
    maxAttempts: Number(process.env.WORKER_MAX_ATTEMPTS ?? 3),
  }

  switch (job.type as JobType) {
    case 'archive_track':
      await tasks.trigger<typeof archiveTrackTask>(triggerTaskIds.archiveTrack, payload, options)
      return
    case 'tag_track_file':
      await tasks.trigger<typeof tagTrackFileTask>(triggerTaskIds.tagTrackFile, payload, options)
      return
    case 'sync_emby_track':
      await tasks.trigger<typeof syncEmbyTrackTask>(triggerTaskIds.syncEmbyTrack, payload, options)
      return
    case 'cleanup_resource_cache':
      await tasks.trigger<typeof cleanupResourceCacheTask>(triggerTaskIds.cleanupResourceCache, payload, options)
      return
    case 'cleanup_track_cache':
      await tasks.trigger<typeof cleanupTrackCacheTask>(triggerTaskIds.cleanupTrackCache, payload, options)
      return
    case 'refresh_um_crypto':
      await tasks.trigger<typeof refreshUmCryptoTask>(triggerTaskIds.refreshUmCrypto, payload, options)
      return
  }
}
