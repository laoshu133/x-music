import { db } from '@/lib/db'
import { deleteCachedResourcesForTrack } from '@/lib/cache/resources'
import { appConfig } from '@/lib/config'
import { getEffectiveSettings } from '@/lib/db/settings'
import path from 'node:path'
import { upsertRemoteMapping } from '@/lib/db/remote-mappings'
import { claimNextJob, completeJob, failJob, requeueJob } from '@/lib/jobs'
import {
  createOrUpdateEmbyPlaylist,
  notifyEmbyMediaUpdated,
  refreshEmbyLibrary,
  searchEmbyAudioByName,
  searchEmbyAudioByPath,
} from './upstream-api'
import { getDefaultUpstreamMusicLibraryLocation } from './auth'
import type { SyncEmbyTrackJobPayload } from './sync'
import { syncMediaFilesToEmbyWebdav } from './webdav'

export interface EmbySyncJobOptions {
  maxAttempts?: number
  cacheWaitMs?: number
  cachePollIntervalMs?: number
  scanWaitMs?: number
  scanPollIntervalMs?: number
}

interface CachedMediaRow {
  finalPath?: string
  rawPath?: string
  lyricsPath?: string
  coverPath?: string
  status?: string
}

const defaultCacheWaitMs = Number(process.env.EMBY_SYNC_CACHE_WAIT_MS ?? 30000)
const defaultCachePollIntervalMs = Number(process.env.EMBY_SYNC_CACHE_POLL_INTERVAL_MS ?? 2000)
const defaultScanWaitMs = Number(process.env.EMBY_SYNC_SCAN_WAIT_MS ?? 60000)
const defaultScanPollIntervalMs = Number(process.env.EMBY_SYNC_SCAN_POLL_INTERVAL_MS ?? 5000)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function processOneEmbySyncJob(options: number | EmbySyncJobOptions = 3): Promise<boolean> {
  const maxAttempts = typeof options === 'number' ? options : options.maxAttempts ?? 3
  const cacheWaitMs = typeof options === 'number' ? defaultCacheWaitMs : options.cacheWaitMs ?? defaultCacheWaitMs
  const cachePollIntervalMs = typeof options === 'number'
    ? defaultCachePollIntervalMs
    : options.cachePollIntervalMs ?? defaultCachePollIntervalMs
  const scanWaitMs = typeof options === 'number' ? defaultScanWaitMs : options.scanWaitMs ?? defaultScanWaitMs
  const scanPollIntervalMs = typeof options === 'number'
    ? defaultScanPollIntervalMs
    : options.scanPollIntervalMs ?? defaultScanPollIntervalMs
  const job = claimNextJob<SyncEmbyTrackJobPayload>({
    type: 'sync_emby_track',
    maxAttempts,
  })

  if (!job) return false

  try {
    const row = await waitForCachedMedia(job.payload, {
      timeoutMs: cacheWaitMs,
      pollIntervalMs: cachePollIntervalMs,
      requireLibraryFinalPath: shouldRequireLibraryFinalPath(),
    })
    const mediaPath = row?.finalPath ?? row?.rawPath
    if (!mediaPath) {
      if (job.attempts >= maxAttempts) {
        failJob(job.id, 'No cached file is ready for Emby sync yet')
      } else {
        requeueJob(job.id, 'No cached file is ready for Emby sync yet')
      }
      return true
    }

    const syncedMedia = row?.finalPath
      ? await syncMediaFilesToEmbyWebdav({
          finalPath: row.finalPath,
          lyricsPath: row.lyricsPath,
          coverPath: row.coverPath,
        })
      : undefined
    const scanPath = syncedMedia
      ? joinEmbyPath(await getDefaultUpstreamMusicLibraryLocation(), syncedMedia.embyPath)
      : mediaPath
    await notifyEmbyMediaUpdated(scanPath).catch(() => refreshEmbyLibrary())
    const embyItemId = await waitForEmbyAudio(job.payload.musicInfo, {
      path: scanPath,
      timeoutMs: scanWaitMs,
      pollIntervalMs: scanPollIntervalMs,
    })
    if (!embyItemId) {
      const message = `Emby scan triggered but item was not found for ${job.payload.musicInfo.name} at ${scanPath}`
      if (job.attempts >= maxAttempts) {
        failJob(job.id, message)
      } else {
        requeueJob(job.id, message)
      }
      return true
    }

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
    await deleteCachedResourcesForTrack({
      source: job.payload.source,
      songmid: job.payload.songmid,
      imageUrl: job.payload.musicInfo.img,
      lyricsUrls: [qqLyricsUrl(job.payload.songmid)],
    }).catch(() => undefined)

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

function joinEmbyPath(root: string | undefined, relativePath: string): string {
  if (!root) return relativePath
  return `${root.replace(/\/+$/g, '')}/${relativePath.replace(/^\/+/g, '')}`
}

async function waitForCachedMedia(
  payload: SyncEmbyTrackJobPayload,
  options: { timeoutMs: number; pollIntervalMs: number; requireLibraryFinalPath?: boolean },
): Promise<CachedMediaRow | undefined> {
  const deadline = Date.now() + Math.max(0, options.timeoutMs)
  for (;;) {
    const row = getCachedMedia(payload)
    if (row && isSyncableCachedMedia(row, options)) return row
    if (Date.now() >= deadline) return undefined
    await sleep(Math.max(100, Math.min(options.pollIntervalMs, deadline - Date.now())))
  }
}

function shouldRequireLibraryFinalPath(): boolean {
  return Boolean(getEffectiveSettings().emby.sourceWebdavDsn)
}

function isSyncableCachedMedia(
  row: CachedMediaRow,
  options: { requireLibraryFinalPath?: boolean },
): boolean {
  if (!options.requireLibraryFinalPath) return Boolean(row.finalPath || row.rawPath)
  return row.status === 'ready' && Boolean(row.finalPath && isPathInside(row.finalPath, appConfig.musicDir))
}

function isPathInside(candidate: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate))
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function getCachedMedia(payload: SyncEmbyTrackJobPayload): CachedMediaRow | undefined {
  return db.prepare(`
    SELECT
      tf.final_path AS finalPath,
      tf.raw_path AS rawPath,
      tf.lyrics_path AS lyricsPath,
      tf.cover_path AS coverPath,
      tf.status
    FROM track_files tf
    INNER JOIN tracks t ON t.id = tf.track_id
    WHERE t.source = ? AND t.songmid = ?
      AND tf.status IN ('ready', 'tagging', 'cached_raw')
    ORDER BY
      CASE tf.status WHEN 'ready' THEN 0 WHEN 'tagging' THEN 1 WHEN 'cached_raw' THEN 2 ELSE 3 END,
      tf.updated_at DESC
    LIMIT 1
  `).get(payload.source, payload.songmid) as CachedMediaRow | undefined
}

async function waitForEmbyAudio(
  musicInfo: SyncEmbyTrackJobPayload['musicInfo'],
  options: { path?: string; timeoutMs: number; pollIntervalMs: number },
): Promise<string | undefined> {
  const deadline = Date.now() + Math.max(0, options.timeoutMs)
  for (;;) {
    const embyItemIdByPath = options.path ? await searchEmbyAudioByPath(options.path) : undefined
    if (embyItemIdByPath) return embyItemIdByPath
    const embyItemId = await searchEmbyAudioByName(musicInfo)
    if (embyItemId) return embyItemId
    if (Date.now() >= deadline) return undefined
    await sleep(Math.max(100, Math.min(options.pollIntervalMs, deadline - Date.now())))
  }
}

function qqLyricsUrl(songmid: string): string {
  return `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?${new URLSearchParams({
    g_tk: '5381',
    format: 'json',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    notice: '0',
    platform: 'h5',
    needNewCode: '1',
    ct: '121',
    cv: '0',
    songmid,
  })}`
}
