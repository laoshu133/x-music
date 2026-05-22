import { db } from '@/lib/db'
import { deleteCachedResourcesForTrack } from '@/lib/cache/resources'
import { upsertRemoteMapping } from '@/lib/db/remote-mappings'
import { claimNextJob, completeJob, failJob, requeueJob } from '@/lib/jobs'
import {
  createOrUpdateEmbyPlaylist,
  notifyEmbyMediaUpdated,
  refreshEmbyLibrary,
  searchEmbyAudioByName,
} from './upstream-api'
import type { SyncEmbyTrackJobPayload } from './sync'

export async function processOneEmbySyncJob(maxAttempts = 3): Promise<boolean> {
  const job = claimNextJob<SyncEmbyTrackJobPayload>({
    type: 'sync_emby_track',
    maxAttempts,
  })

  if (!job) return false

  try {
    const row = db.prepare(`
      SELECT tf.final_path AS finalPath, tf.raw_path AS rawPath, tf.status
      FROM track_files tf
      INNER JOIN tracks t ON t.id = tf.track_id
      WHERE t.source = ? AND t.songmid = ?
        AND tf.status IN ('ready', 'tagging', 'cached_raw')
      ORDER BY
        CASE tf.status WHEN 'ready' THEN 0 WHEN 'tagging' THEN 1 WHEN 'cached_raw' THEN 2 ELSE 3 END,
        tf.updated_at DESC
      LIMIT 1
    `).get(job.payload.source, job.payload.songmid) as { finalPath?: string; rawPath?: string; status?: string } | undefined

    const mediaPath = row?.finalPath ?? row?.rawPath
    if (!mediaPath) {
      if (job.attempts >= maxAttempts) {
        failJob(job.id, 'No cached file is ready for Emby sync yet')
      } else {
        requeueJob(job.id, 'No cached file is ready for Emby sync yet')
      }
      return true
    }

    await notifyEmbyMediaUpdated(mediaPath).catch(() => refreshEmbyLibrary())
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
      await deleteCachedResourcesForTrack({
        source: job.payload.source,
        songmid: job.payload.songmid,
        imageUrl: job.payload.musicInfo.img,
        lyricsUrls: [qqLyricsUrl(job.payload.songmid)],
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
