import { db } from '@/lib/db'
import { isPlayableAudioFileName, isPlayableAudioPath, markMissingTrackFile } from '@/lib/cache/store'
import { deleteCachedResourcesForTrack } from '@/lib/cache/resources'
import { appConfig } from '@/lib/config'
import { getEffectiveSettings } from '@/lib/db/settings'
import path from 'node:path'
import { rmdir, rm } from 'node:fs/promises'
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
import { decodeVirtualId } from './virtual-ids'
import { loadVirtualPlaylist } from './virtual-store'
import { qualityFallbacks } from '@/lib/music-url/resolve'
import type { SyncEmbyTrackJobPayload } from './sync'
import type { MusicQuality } from '@/lib/types'
import { syncMediaFilesToEmbyWebdav } from './webdav'

export interface EmbySyncJobOptions {
  maxAttempts?: number
  cacheWaitMs?: number
  cachePollIntervalMs?: number
  scanWaitMs?: number
  scanPollIntervalMs?: number
}

interface CachedMediaRow {
  id: number
  quality: string
  finalPath?: string
  rawPath?: string
  lyricsPath?: string
  coverPath?: string
  status?: string
  unsupportedPath?: string
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
    if (row?.unsupportedPath) {
      failJob(job.id, `Cached file format is not syncable to Emby: ${row.unsupportedPath}`)
      return true
    }
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
      requirePathMatch: Boolean(syncedMedia),
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
    const playlistName = syncedPlaylistName(job.payload.playlistId)
    if (playlistName) {
      await createOrUpdateEmbyPlaylist({
        name: playlistName,
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
    if (syncedMedia) {
      await deleteLocalSyncedMedia({
        source: job.payload.source,
        songmid: job.payload.songmid,
        uploadedPaths: syncedMedia.uploadedPaths,
      }).catch(() => undefined)
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

function joinEmbyPath(root: string | undefined, relativePath: string): string {
  if (!root) return relativePath
  return `${root.replace(/\/+$/g, '')}/${relativePath.replace(/^\/+/g, '')}`
}

async function waitForCachedMedia(
  payload: SyncEmbyTrackJobPayload,
  options: { timeoutMs: number; pollIntervalMs: number; requireLibraryFinalPath?: boolean },
): Promise<CachedMediaRow | undefined> {
  const deadline = Date.now() + Math.max(0, options.timeoutMs)
  const preferredQuality = preferredSyncQuality(payload)
  for (;;) {
    const row = getCachedMedia(payload, [preferredQuality])
      ?? (Date.now() >= deadline ? getCachedMedia(payload, qualityFallbacks(preferredQuality).slice(1)) : undefined)
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

function syncedPlaylistName(playlistId?: string): string | undefined {
  if (!playlistId) return undefined
  const decoded = decodeVirtualId(playlistId)
  if (!decoded || decoded.kind !== 'qq-playlist') return undefined
  const playlist = loadVirtualPlaylist(decoded.id)
  return playlist?.name?.trim() ? playlist.name : undefined
}

function preferredSyncQuality(payload: SyncEmbyTrackJobPayload): MusicQuality {
  const available = new Set((payload.musicInfo.types ?? [])
    .map(item => item.type)
    .filter((quality): quality is MusicQuality => quality === 'flac' || quality === '320k' || quality === '128k'))
  return qualityFallbacks('flac').find(quality => available.has(quality))
    ?? getCachedQualities(payload)[0]
    ?? 'flac'
}

function getCachedQualities(payload: SyncEmbyTrackJobPayload): MusicQuality[] {
  const rows = db.prepare(`
    SELECT DISTINCT tf.quality
    FROM track_files tf
    INNER JOIN tracks t ON t.id = tf.track_id
    WHERE t.source = ? AND t.songmid = ?
      AND tf.status IN ('ready', 'tagging', 'cached_raw')
  `).all(payload.source, payload.songmid) as Array<{ quality: string }>
  const cached = new Set(rows
    .map(row => row.quality)
    .filter((quality): quality is MusicQuality => quality === 'flac' || quality === '320k' || quality === '128k'))
  return qualityFallbacks('flac').filter(quality => cached.has(quality))
}

function getCachedMedia(payload: SyncEmbyTrackJobPayload, qualities: MusicQuality[] = qualityFallbacks('flac')): CachedMediaRow | undefined {
  if (!qualities.length) return undefined
  const qualityParams = Object.fromEntries(qualities.map((quality, index) => [`quality${index}`, quality]))
  const rows = db.prepare(`
    SELECT
      tf.id,
      tf.quality,
      tf.final_path AS finalPath,
      tf.raw_path AS rawPath,
      tf.lyrics_path AS lyricsPath,
      tf.cover_path AS coverPath,
      tf.status
    FROM track_files tf
    INNER JOIN tracks t ON t.id = tf.track_id
    WHERE t.source = @source AND t.songmid = @songmid
      AND tf.quality IN (${qualities.map((_, index) => `@quality${index}`).join(',')})
      AND tf.status IN ('ready', 'tagging', 'cached_raw')
    ORDER BY
      CASE tf.status WHEN 'ready' THEN 0 WHEN 'tagging' THEN 1 WHEN 'cached_raw' THEN 2 ELSE 3 END,
      CASE tf.quality WHEN 'flac' THEN 0 WHEN '320k' THEN 1 WHEN '128k' THEN 2 ELSE 3 END,
      tf.updated_at DESC
  `).all({
    source: payload.source,
    songmid: payload.songmid,
    ...qualityParams,
  }) as CachedMediaRow[]

  for (const row of rows) {
    const mediaPath = row.finalPath ?? row.rawPath
    if (!mediaPath) continue
    if (!isPlayableAudioFileName(mediaPath)) {
      return { ...row, unsupportedPath: mediaPath }
    }
    if (isPlayableAudioPath(mediaPath)) return row
    markMissingTrackFile(row.id, `Cached file is missing or not playable: ${mediaPath}`)
  }
  return undefined
}

async function deleteLocalSyncedMedia(input: {
  source: string
  songmid: string
  uploadedPaths: string[]
}): Promise<void> {
  if (!input.uploadedPaths.length) return

  const rows = db.prepare(`
    SELECT
      tf.id,
      tf.raw_path AS rawPath,
      tf.final_path AS finalPath,
      tf.lyrics_path AS lyricsPath,
      tf.cover_path AS coverPath
    FROM track_files tf
    INNER JOIN tracks t ON t.id = tf.track_id
    WHERE t.source = ? AND t.songmid = ?
  `).all(input.source, input.songmid) as Array<{
    id: number
    rawPath?: string | null
    finalPath?: string | null
    lyricsPath?: string | null
    coverPath?: string | null
  }>

  const uploaded = new Set(input.uploadedPaths.map(uploadedPath => normalizeRelativeMusicPath(uploadedPath)))
  for (const row of rows) {
    const columns = {
      raw_path: row.rawPath ?? undefined,
      final_path: row.finalPath ?? undefined,
      lyrics_path: row.lyricsPath ?? undefined,
      cover_path: row.coverPath ?? undefined,
    }
    const deletedColumns: string[] = []
    for (const [column, filePath] of Object.entries(columns)) {
      if (!filePath) continue
      if (!uploaded.has(normalizeRelativeMusicPath(path.relative(appConfig.musicDir, filePath)))) continue
      await rm(filePath, { force: true }).catch(() => undefined)
      await pruneEmptyMusicDirectories(path.dirname(filePath)).catch(() => undefined)
      deletedColumns.push(column)
    }
    if (deletedColumns.length) {
      db.prepare(`
        UPDATE track_files
        SET ${deletedColumns.map(column => `${column} = NULL`).join(', ')},
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(row.id)
    }
  }
}

async function pruneEmptyMusicDirectories(startDir: string): Promise<void> {
  const root = path.resolve(appConfig.musicDir)
  let current = path.resolve(startDir)
  while (isPathInside(current, root)) {
    await rmdir(current)
    current = path.dirname(current)
  }
}

function normalizeRelativeMusicPath(value: string): string {
  return value.split(path.sep).join('/').replace(/^\/+/, '')
}

async function waitForEmbyAudio(
  musicInfo: SyncEmbyTrackJobPayload['musicInfo'],
  options: { path?: string; timeoutMs: number; pollIntervalMs: number; requirePathMatch?: boolean },
): Promise<string | undefined> {
  const deadline = Date.now() + Math.max(0, options.timeoutMs)
  for (;;) {
    const embyItemIdByPath = options.path ? await searchEmbyAudioByPath(options.path) : undefined
    if (embyItemIdByPath) return embyItemIdByPath
    if (!options.requirePathMatch) {
      const embyItemId = await searchEmbyAudioByName(musicInfo)
      if (embyItemId) return embyItemId
    }
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
