import { ensureTrack, getPlayableTrackFile, hasActiveTrackFile, upsertTrackFileStatus } from '@/lib/cache/store'
import { createUpstreamTeeResponse } from '@/lib/cache/stream'
import { db } from '@/lib/db'
import { createJob, claimJobById, claimNextJob, completeJob, failJob, requeueJob } from '@/lib/jobs'
import { MusicUrlResolveError, qualityFallbacks, resolveMusicUrl } from '@/lib/music-url/resolve'
import { highestAvailableQuality } from '@/lib/quality'
import type { MusicInfo, MusicQuality } from '@/lib/types'

export interface ArchiveTrackJobPayload {
  source: 'tx'
  songmid: string
  musicInfo: MusicInfo
  preferredQuality?: MusicQuality
  reason: 'playback_completed' | 'favorite' | 'manual' | 'background'
  playlistId?: string
}

export function enqueueTrackArchive(input: ArchiveTrackJobPayload): void {
  const existing = db.prepare(`
    SELECT id
    FROM jobs
    WHERE type = 'archive_track'
      AND status IN ('queued', 'running')
      AND json_extract(payload_json, '$.source') = @source
      AND json_extract(payload_json, '$.songmid') = @songmid
    LIMIT 1
  `).get({
    source: input.source,
    songmid: input.songmid,
  }) as { id: number } | undefined
  if (existing) return

  createJob({
    type: 'archive_track',
    payload: input,
  })
}

export async function processOneArchiveTrackJob(maxAttempts = 3): Promise<boolean> {
  const job = claimNextJob<ArchiveTrackJobPayload>({
    type: 'archive_track',
    maxAttempts,
  })
  if (!job) return false

  try {
    await archiveTrack(job.payload)
    completeJob(job.id)
  } catch (error) {
    if (job.attempts >= maxAttempts) {
      failJob(job.id, error)
    } else {
      requeueJob(job.id, error, maxAttempts)
    }
  }
  return true
}

export async function processArchiveTrackJobById(jobId: number): Promise<void> {
  const maxAttempts = Number(process.env.WORKER_MAX_ATTEMPTS ?? 3)
  const job = claimJobById<ArchiveTrackJobPayload>({
    id: jobId,
    type: 'archive_track',
    maxAttempts,
  })
  if (!job) return

  try {
    await archiveTrack(job.payload)
    completeJob(job.id)
  } catch (error) {
    if (job.attempts >= maxAttempts) {
      failJob(job.id, error)
    } else {
      requeueJob(job.id, error, maxAttempts)
    }
    throw error
  }
}

export async function archiveTrack(payload: ArchiveTrackJobPayload): Promise<void> {
  const musicInfo = payload.musicInfo
  const preferredQuality = payload.preferredQuality ?? highestAvailableQuality(musicInfo)
  if (getPlayableTrackFile(musicInfo.source, musicInfo.songmid, preferredQuality)) return

  const track = ensureTrack(musicInfo)
  const attempts: Array<{ quality: MusicQuality; error: string; source?: string; musicId?: string }> = []

  for (const quality of qualityFallbacks(preferredQuality)) {
    if (getPlayableTrackFile(musicInfo.source, musicInfo.songmid, quality)) return
    if (await waitForActiveTrackFile(musicInfo, quality)) return

    try {
      upsertTrackFileStatus(track.id, quality, 'resolving_url')
      const resolved = await resolveMusicUrl(musicInfo, quality)
      const { response, completion } = await createUpstreamTeeResponse(
        resolved.url,
        track,
        resolved.quality,
        new Request('http://x-music.local/internal/archive-track'),
        resolved.ekey,
        { librarySync: true, client: false },
      )
      if (!response.ok) throw new Error(`archive upstream returned ${response.status}`)
      await response.arrayBuffer()
      await completion
      return
    } catch (error) {
      const message = musicUrlErrorMessage(error)
      if (error instanceof MusicUrlResolveError) {
        attempts.push(...error.attempts)
      } else {
        attempts.push({ quality, error: message })
      }
      upsertTrackFileStatus(track.id, quality, 'failed', { error: message })
    }
  }

  throw new Error(`Unable to archive track ${musicInfo.source}:${musicInfo.songmid}. ${attempts.map(attempt => `${attempt.quality}${attempt.source ? `/${attempt.source}` : ''}: ${attempt.error}`).join('; ')}`)
}

async function waitForActiveTrackFile(musicInfo: MusicInfo, quality: MusicQuality): Promise<boolean> {
  if (!hasActiveTrackFile(musicInfo.source, musicInfo.songmid, [quality])) return false

  const waitMs = numericEnv('ARCHIVE_ACTIVE_WAIT_MS', 30_000, 0)
  const pollIntervalMs = numericEnv('ARCHIVE_ACTIVE_POLL_INTERVAL_MS', 250, 10)
  const deadline = Date.now() + waitMs
  for (;;) {
    if (getPlayableTrackFile(musicInfo.source, musicInfo.songmid, quality)) return true
    if (!hasActiveTrackFile(musicInfo.source, musicInfo.songmid, [quality])) return false
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for active track cache ${musicInfo.source}:${musicInfo.songmid}:${quality}`)
    }
    await new Promise(resolve => setTimeout(resolve, Math.max(10, Math.min(pollIntervalMs, deadline - Date.now()))))
  }
}

function numericEnv(name: string, fallback: number, minimum: number): number {
  const value = Number(process.env[name] ?? fallback)
  return Number.isFinite(value) ? Math.max(minimum, value) : fallback
}

function musicUrlErrorMessage(error: unknown): string {
  if (error instanceof MusicUrlResolveError && error.attempts.length) {
    return error.attempts
      .map(attempt => `${attempt.source ? `${attempt.source}: ` : ''}${attempt.error}`)
      .join('; ')
  }
  return error instanceof Error ? error.message : String(error)
}
