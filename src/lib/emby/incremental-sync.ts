import type { AccountRecord } from '@/lib/db/accounts'
import { getRemoteMapping, upsertRemoteMapping } from '@/lib/db/remote-mappings'
import { getQQFavoriteSongs, getQQPlaylistDetail, getQQUserPlaylists } from '@/lib/qq'
import type { MusicInfo, QQPlaylistInfo } from '@/lib/types'
import { createOrUpdateEmbyPlaylist, searchEmbyPlaylistByName } from './upstream-api'
import { syncEmbyFavoritesFromQQList } from './favorites'
import { hasUpstreamEmbyConfigured } from './auth'

export interface IncrementalEmbySyncResult {
  favorites: {
    attempted: number
    synced: number
    failed: number
    skipped: number
  }
  playlists: {
    attempted: number
    synced: number
    failed: number
    skipped: number
    errors: Array<{ playlistId: string; error: string }>
  }
}

const emptySyncStats = () => ({
  attempted: 0,
  synced: 0,
  failed: 0,
  skipped: 0,
})

export async function incrementalSyncQQToEmby(input: {
  account: AccountRecord
  favoriteLimit?: number
  playlistLimit?: number
  syncFavorites?: boolean
  syncPlaylists?: boolean
}): Promise<IncrementalEmbySyncResult> {
  if (!hasUpstreamEmbyConfigured(input.account)) {
    throw new Error('Upstream Emby is not configured')
  }

  const shouldSyncFavorites = input.syncFavorites ?? true
  const shouldSyncPlaylists = input.syncPlaylists ?? true
  const favoriteLimit = input.favoriteLimit ?? 500
  const playlistLimit = input.playlistLimit ?? 50

  const favorites = shouldSyncFavorites
    ? await syncQQFavoritesToEmby({
      account: input.account,
      limit: favoriteLimit,
    })
    : emptySyncStats()

  const playlists = shouldSyncPlaylists
    ? await syncQQPlaylistsToEmby({
      account: input.account,
      limit: playlistLimit,
    })
    : { ...emptySyncStats(), errors: [] }

  return {
    favorites: {
      attempted: favorites.attempted,
      synced: favorites.synced,
      failed: favorites.failed,
      skipped: favorites.skipped,
    },
    playlists,
  }
}

async function syncQQFavoritesToEmby(input: {
  account: AccountRecord
  limit: number
}): Promise<IncrementalEmbySyncResult['favorites']> {
  const favoritePage = await getQQFavoriteSongs({
    cookie: input.account.qqCookie,
    page: 1,
    limit: input.limit,
  })
  const favorites = await syncEmbyFavoritesFromQQList({
    account: input.account,
    qqFavorites: favoritePage.list,
    limit: input.limit,
  })
  return {
    attempted: favorites.attempted,
    synced: favorites.synced,
    failed: favorites.failed,
    skipped: favorites.skipped,
  }
}

async function syncQQPlaylistsToEmby(input: {
  account: AccountRecord
  limit: number
}): Promise<IncrementalEmbySyncResult['playlists']> {
  const page = await getQQUserPlaylists({
    uin: input.account.qqUin,
    cookie: input.account.qqCookie,
    offset: 0,
    limit: input.limit,
  })
  const errors: Array<{ playlistId: string; error: string }> = []
  let synced = 0
  let skipped = 0

  for (const playlist of page.list) {
    try {
      const detail = await getQQPlaylistDetail(playlist.id)
      const itemIds = mappedEmbyItemIds(detail.list, input.account)
      if (!itemIds.length) {
        skipped += 1
        continue
      }

      const remoteId = await createOrUpdateEmbyPlaylist({
        name: playlist.name,
        itemIds,
      }, { account: input.account })
      if (!remoteId) {
        skipped += 1
        continue
      }
      upsertRemoteMapping({
        userId: input.account.userId,
        localType: 'playlist',
        localKey: `qq:${playlist.id}`,
        remote: 'emby',
        remoteId,
        raw: playlist,
      })
      synced += 1
    } catch (error) {
      const remoteId = await fallbackPlaylistMapping(playlist, input.account).catch(() => undefined)
      if (remoteId) {
        synced += 1
        continue
      }
      errors.push({ playlistId: playlist.id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return {
    attempted: page.list.length,
    synced,
    failed: errors.length,
    skipped,
    errors,
  }
}

function mappedEmbyItemIds(songs: MusicInfo[], account: AccountRecord): string[] {
  const ids = new Set<string>()
  for (const song of songs) {
    const mapping = getRemoteMapping({
      userId: account.userId,
      localType: 'track',
      localKey: `${song.source}:${song.songmid}`,
      remote: 'emby',
    })
    if (mapping?.remoteId) ids.add(mapping.remoteId)
  }
  return [...ids]
}

async function fallbackPlaylistMapping(playlist: QQPlaylistInfo, account: AccountRecord): Promise<string | undefined> {
  const remoteId = await searchEmbyPlaylistByName(playlist.name, { account })
  if (!remoteId) return undefined
  upsertRemoteMapping({
    userId: account.userId,
    localType: 'playlist',
    localKey: `qq:${playlist.id}`,
    remote: 'emby',
    remoteId,
    raw: playlist,
  })
  return remoteId
}
