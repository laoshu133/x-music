import { ensureTrack, insertPlayEvent, listPlayHistory } from '@/lib/cache/store'
import type { AccountRecord } from '@/lib/db/accounts'
import { getRemoteMapping } from '@/lib/db/remote-mappings'
import { resolveMusicUrlWithFallback } from '@/lib/music-url/resolve'
import { syncQQPlayHistory } from '@/lib/qq'
import type { MusicInfo, PlayHistoryRecord } from '@/lib/types'
import { musicInfoFromEmbyMappedItem } from './favorites'
import { fetchEmbyPlayedAudioItems, markEmbyPlayed } from './upstream-api'

export async function pullEmbyPlayHistory(input: {
  account: AccountRecord | undefined
  limit?: number
  syncQQ?: boolean
}): Promise<{
  source: 'emby'
  list: PlayHistoryRecord[]
  pulled: number
  qqSynced: number
  qqFailed: number
  skipped: number
  errors: Array<{ itemId?: string; songmid?: string; error: string }>
}> {
  const account = input.account
  if (!account?.embyUserId) {
    return { source: 'emby', list: [], pulled: 0, qqSynced: 0, qqFailed: 0, skipped: 0, errors: [] }
  }

  const response = await fetchEmbyPlayedAudioItems({
    userId: account.embyUserId,
    limit: input.limit ?? 200,
    sortBy: 'DatePlayed',
  })
  const errors: Array<{ itemId?: string; songmid?: string; error: string }> = []
  let pulled = 0
  let skipped = 0
  let qqSynced = 0
  let qqFailed = 0

  for (const item of response.Items ?? []) {
    const song = musicInfoFromEmbyMappedItem(item)
    const lastPlayedAt = normalizeDate(item.UserData?.LastPlayedDate)
    if (!song || !lastPlayedAt) {
      skipped += 1
      continue
    }

    const track = ensureTrack(song)
    insertPlayEvent(track.id, '320k', account.qqUin, lastPlayedAt)
    pulled += 1

    if (input.syncQQ !== false) {
      try {
        const resolved = await resolveMusicUrlWithFallback(song, '320k')
        const result = await syncQQPlayHistory({
          cookie: account.qqCookie,
          musicInfo: song,
          quality: resolved.quality,
          playUrl: resolved.url,
        })
        if (result.synced) {
          qqSynced += 1
        } else {
          qqFailed += 1
          errors.push({
            itemId: item.Id,
            songmid: song.songmid,
            error: result.skipped ? result.reason : result.error,
          })
        }
      } catch (error) {
        qqFailed += 1
        errors.push({ itemId: item.Id, songmid: song.songmid, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  return {
    source: 'emby',
    list: listPlayHistory(input.limit ?? 50),
    pulled,
    qqSynced,
    qqFailed,
    skipped,
    errors,
  }
}

export async function pushLocalPlayHistoryToEmby(input: {
  account: AccountRecord | undefined
  limit?: number
}): Promise<{
  source: 'emby'
  attempted: number
  synced: number
  failed: number
  skipped: number
  errors: Array<{ songmid: string; error: string }>
}> {
  const embyUserId = input.account?.embyUserId
  if (!embyUserId) {
    return { source: 'emby', attempted: 0, synced: 0, failed: 0, skipped: 0, errors: [] }
  }

  const events = listPlayHistory(input.limit ?? 200)
  const errors: Array<{ songmid: string; error: string }> = []
  let synced = 0
  let skipped = 0

  for (const event of events) {
    const remoteItemId = mappedEmbyItemId(event)
    if (!remoteItemId) {
      skipped += 1
      continue
    }
    try {
      await markEmbyPlayed({
        userId: embyUserId,
        itemId: remoteItemId,
        datePlayed: event.playedAt,
      })
      synced += 1
    } catch (error) {
      errors.push({ songmid: event.songmid, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return {
    source: 'emby',
    attempted: events.length,
    synced,
    failed: errors.length,
    skipped,
    errors,
  }
}

function mappedEmbyItemId(song: Pick<MusicInfo, 'source' | 'songmid'>): string | undefined {
  return getRemoteMapping({
    localType: 'track',
    localKey: `${song.source}:${song.songmid}`,
    remote: 'emby',
  })?.remoteId
}

function normalizeDate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}
