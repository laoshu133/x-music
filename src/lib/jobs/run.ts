import { processArchiveTrackJobById } from '@/lib/archive/track'
import { processCleanupResourceCacheJobById } from '@/lib/cache/cleanup-job'
import { processRefreshUmCryptoJobById } from '@/lib/cache/um-crypto-job'
import { processEmbySyncJobById } from '@/lib/emby/sync-worker'
import type { JobType } from '@/lib/jobs'
import { processTagTrackFileJobById } from '@/lib/tagging/job'

export interface RunJobByIdInput {
  jobId: number
  type: JobType
}

export async function runJobById(input: RunJobByIdInput): Promise<void> {
  switch (input.type) {
    case 'archive_track':
      await processArchiveTrackJobById(input.jobId)
      return
    case 'tag_track_file':
      await processTagTrackFileJobById(input.jobId)
      return
    case 'sync_emby_track':
      await processEmbySyncJobById(input.jobId)
      return
    case 'cleanup_resource_cache':
      await processCleanupResourceCacheJobById(input.jobId)
      return
    case 'refresh_um_crypto':
      await processRefreshUmCryptoJobById(input.jobId)
      return
  }
}

export async function runJobByIdThroughConfiguredRunner(input: RunJobByIdInput): Promise<void> {
  const runnerUrl = process.env.X_MUSIC_TASK_RUNNER_URL
  if (!runnerUrl) {
    await runJobById(input)
    return
  }

  const secret = process.env.X_MUSIC_TASK_RUNNER_SECRET ?? process.env.TRIGGER_SECRET_KEY
  if (!secret) throw new Error('X_MUSIC_TASK_RUNNER_SECRET is required when X_MUSIC_TASK_RUNNER_URL is set')

  const response = await fetch(runnerUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`XMusic task runner returned ${response.status}${body ? `: ${body}` : ''}`)
  }
}
