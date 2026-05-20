import { appConfig } from '@/lib/config'
import { db } from '@/lib/db'
import {
  claimNextJob,
  completeJob,
  ensureJobsTable,
  failJob,
  requeueJob,
} from '@/lib/jobs'
import {
  createOrUpdateEmbyPlaylist,
  notifyEmbyMediaUpdated,
  refreshEmbyLibrary,
  searchEmbyAudioByName,
} from '@/lib/emby/upstream-api'
import { upsertRemoteMapping } from '@/lib/db/remote-mappings'
import { cleanupInboxFile } from '@/lib/tagging/cleanup'
import { createTaggingProvider } from '@/lib/tagging/provider'
import type { TagTrackFileJobPayload } from '@/lib/tagging/types'
import type { SyncEmbyTrackJobPayload } from '@/lib/emby/sync'

const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000)
const maxAttempts = Number(process.env.WORKER_MAX_ATTEMPTS ?? 3)

const taggingProvider = createTaggingProvider()

let stopping = false

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
  const job = claimNextJob<SyncEmbyTrackJobPayload>({
    type: 'sync_emby_track',
    maxAttempts,
  })

  if (!job) return false

  try {
    const row = db.prepare(`
      SELECT tf.final_path AS finalPath, tf.raw_path AS rawPath
      FROM track_files tf
      INNER JOIN tracks t ON t.id = tf.track_id
      WHERE t.source = ? AND t.songmid = ?
      ORDER BY
        CASE tf.status WHEN 'ready' THEN 0 WHEN 'tagging' THEN 1 WHEN 'cached_raw' THEN 2 ELSE 3 END,
        tf.updated_at DESC
      LIMIT 1
    `).get(job.payload.source, job.payload.songmid) as { finalPath?: string; rawPath?: string } | undefined

    await notifyEmbyMediaUpdated(row?.finalPath ?? row?.rawPath).catch(() => refreshEmbyLibrary())
    const embyItemId = await searchEmbyAudioByName(job.payload.musicInfo)
    if (embyItemId) {
      upsertRemoteMapping({
        localType: 'track',
        localKey: `${job.payload.source}:${job.payload.songmid}`,
        remote: 'emby',
        remoteId: embyItemId,
        raw: job.payload.musicInfo,
      })
      if (job.payload.playlistId) {
        await createOrUpdateEmbyPlaylist({
          name: `QQ ${job.payload.playlistId}`,
          itemIds: [embyItemId],
        }).catch((error: unknown) => {
          console.warn(`failed to update Emby playlist ${job.payload.playlistId}`, error)
        })
      }
    }

    completeJob(job.id)
  } catch (error) {
    if (job.attempts >= maxAttempts) {
      failJob(job.id, error)
    } else {
      requeueJob(job.id, error)
    }
  }

  return true
}

async function main(): Promise<void> {
  ensureJobsTable()

  console.log('miXmusic worker started')
  console.log(`data dir: ${appConfig.dataDir}`)
  console.log(`poll interval: ${pollIntervalMs}ms`)

  while (!stopping) {
    const didWork = await processTagJob() || await processEmbySyncJob()
    if (!didWork) await sleep(pollIntervalMs)
  }
}

installShutdownHandler('SIGINT')
installShutdownHandler('SIGTERM')

main().catch((error) => {
  console.error('worker crashed', error)
  process.exitCode = 1
})
