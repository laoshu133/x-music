import { getRemoteMapping, getRemoteMappingByRemote } from '@/lib/db/remote-mappings'
import type { AccountRecord } from '@/lib/db/accounts'
import type { MusicInfo } from '@/lib/types'
import { listLocalFavoritesForAccount, setLocalFavoriteSynced, type FavoriteRecord } from '@/lib/db/favorites'
import { setQQFavoriteSong } from '@/lib/qq'
import { fetchEmbyFavoriteAudioItems, setEmbyFavorite, type EmbyAudioUserDataItem } from './upstream-api'

export interface EmbyFavoriteSyncResult {
  attempted: boolean
  synced: boolean
  remoteItemId?: string
  error?: string
}

export async function syncMappedEmbyFavoriteBestEffort(
  account: AccountRecord | undefined,
  song: MusicInfo,
  favorite: boolean,
): Promise<EmbyFavoriteSyncResult> {
  const embyUserId = account?.embyUserId
  const remoteItemId = getRemoteMapping({
    localType: 'track',
    localKey: `${song.source}:${song.songmid}`,
    remote: 'emby',
  })?.remoteId
  if (!embyUserId || !remoteItemId) return { attempted: false, synced: false }

  try {
    await setEmbyFavorite({
      userId: embyUserId,
      itemId: remoteItemId,
      favorite,
    })
    return { attempted: true, synced: true, remoteItemId }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`failed to sync Emby favorite state for ${song.name}`, error)
    return { attempted: true, synced: false, remoteItemId, error: message }
  }
}

export async function pushLocalFavoritesToEmby(input: {
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

  const favorites = listLocalFavoritesForAccount(input.account?.qqUin)
    .filter(record => record.desiredState === 'favorite')
    .slice(0, input.limit ?? 200)
  const errors: Array<{ songmid: string; error: string }> = []
  let synced = 0
  let skipped = 0

  for (const record of favorites) {
    const remoteItemId = mappedEmbyItemId(record)
    if (!remoteItemId) {
      skipped += 1
      continue
    }
    try {
      await setEmbyFavorite({ userId: embyUserId, itemId: remoteItemId, favorite: true })
      synced += 1
    } catch (error) {
      errors.push({ songmid: record.songmid, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return {
    source: 'emby',
    attempted: favorites.length,
    synced,
    failed: errors.length,
    skipped,
    errors,
  }
}

export async function pullEmbyFavorites(input: {
  account: AccountRecord | undefined
  limit?: number
  syncQQ?: boolean
}): Promise<{
  source: 'emby'
  list: FavoriteRecord[]
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

  const response = await fetchEmbyFavoriteAudioItems({
    userId: account.embyUserId,
    limit: input.limit ?? 200,
  })
  const errors: Array<{ itemId?: string; songmid?: string; error: string }> = []
  let pulled = 0
  let qqSynced = 0
  let qqFailed = 0
  let skipped = 0

  for (const item of response.Items ?? []) {
    const song = musicInfoFromEmbyMappedItem(item)
    if (!song) {
      skipped += 1
      continue
    }
    setLocalFavoriteSynced(song, true, account.qqUin)
    pulled += 1

    if (input.syncQQ !== false) {
      try {
        await setQQFavoriteSong({
          cookie: account.qqCookie,
          songmid: song.songmid,
          favorited: true,
          raw: song.raw,
        })
        qqSynced += 1
      } catch (error) {
        qqFailed += 1
        errors.push({ itemId: item.Id, songmid: song.songmid, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  return {
    source: 'emby',
    list: listLocalFavoritesForAccount(account.qqUin).filter(record => record.desiredState === 'favorite'),
    pulled,
    qqSynced,
    qqFailed,
    skipped,
    errors,
  }
}

export async function syncEmbyFavoritesFromQQList(input: {
  account: AccountRecord | undefined
  qqFavorites: MusicInfo[]
  limit?: number
}): Promise<{
  attempted: number
  synced: number
  failed: number
  skipped: number
  errors: Array<{ songmid: string; error: string }>
}> {
  const embyUserId = input.account?.embyUserId
  if (!embyUserId) return { attempted: 0, synced: 0, failed: 0, skipped: 0, errors: [] }

  const embyFavorites = await fetchEmbyFavoriteAudioItems({
    userId: embyUserId,
    limit: input.limit ?? 500,
  }).catch(() => ({ Items: [] }))
  const embyFavoriteIds = new Set((embyFavorites.Items ?? []).map(item => item.Id).filter((id): id is string => Boolean(id)))
  const mappings = dedupeSongs(input.qqFavorites)
    .map(song => getRemoteMapping({ localType: 'track', localKey: `${song.source}:${song.songmid}`, remote: 'emby' }))
    .filter((mapping): mapping is NonNullable<typeof mapping> => Boolean(mapping))
    .slice(0, input.limit ?? 500)
  const errors: Array<{ songmid: string; error: string }> = []
  let synced = 0
  let skipped = 0

  for (const mapping of mappings) {
    if (embyFavoriteIds.has(mapping.remoteId)) {
      skipped += 1
      continue
    }

    const songmid = mapping.localKey.slice('tx:'.length)
    try {
      await setEmbyFavorite({
        userId: embyUserId,
        itemId: mapping.remoteId,
        favorite: true,
      })
      synced += 1
    } catch (error) {
      errors.push({ songmid, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return {
    attempted: mappings.length,
    synced,
    failed: errors.length,
    skipped,
    errors,
  }
}

function dedupeSongs(songs: MusicInfo[]): MusicInfo[] {
  const seen = new Set<string>()
  const result: MusicInfo[] = []
  for (const song of songs) {
    const key = `${song.source}:${song.songmid}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(song)
  }
  return result
}

function mappedEmbyItemId(song: Pick<FavoriteRecord, 'source' | 'songmid'>): string | undefined {
  return getRemoteMapping({
    localType: 'track',
    localKey: `${song.source}:${song.songmid}`,
    remote: 'emby',
  })?.remoteId
}

export function musicInfoFromEmbyMappedItem(item: EmbyAudioUserDataItem): MusicInfo | undefined {
  const itemId = item.Id
  if (!itemId) return undefined

  const mapping = getRemoteMappingByRemote({ remote: 'emby', remoteId: itemId })
  const mapped = parseMappedMusicInfo(mapping?.rawJson)
  if (mapped) return mapped

  return musicInfoFromProviderIds(item)
}

function parseMappedMusicInfo(rawJson?: string): MusicInfo | undefined {
  if (!rawJson) return undefined
  try {
    const raw = JSON.parse(rawJson) as Partial<MusicInfo>
    if (raw.source === 'tx' && raw.songmid && raw.name && raw.singer) {
      return {
        source: 'tx',
        songmid: raw.songmid,
        name: raw.name,
        singer: raw.singer,
        albumName: raw.albumName,
        albumId: raw.albumId,
        interval: raw.interval,
        img: raw.img,
        types: raw.types,
        raw: raw.raw ?? raw,
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

function musicInfoFromProviderIds(item: EmbyAudioUserDataItem): MusicInfo | undefined {
  const providerIds = item.ProviderIds ?? {}
  const songmid = providerIds.qqmusic
    ?? providerIds.QQMusic
    ?? providerIds.qq
    ?? providerIds.QQ
    ?? providerIds.tx
    ?? providerIds.TX
  if (!songmid || !item.Name) return undefined
  const singer = item.Artists?.join(', ') || 'Unknown Artist'
  return {
    source: 'tx',
    songmid,
    name: item.Name,
    singer,
    albumName: item.Album,
    raw: item,
  }
}
