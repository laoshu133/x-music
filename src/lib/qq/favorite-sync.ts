import {
  listPendingFavoriteSync,
  markFavoriteSyncState,
  reconcileLocalFavoritesFromRemote,
  setLocalFavoriteSynced,
  type FavoriteRecord,
  type FavoriteSyncResult,
} from '@/lib/db/favorites'
import type { MusicInfo } from '@/lib/types'
import { getQQFavoriteSongs, setQQFavoriteSong } from './favorites'

export async function syncPendingFavorites(input: { cookie?: string; limit?: number } = {}): Promise<FavoriteSyncResult> {
  const pending = listPendingFavoriteSync(input.limit ?? 50)
  const errors: FavoriteSyncResult['errors'] = []
  let synced = 0

  for (const record of pending) {
    try {
      await setQQFavoriteSong({
        cookie: input.cookie,
        songmid: record.songmid,
        favorited: record.desiredState === 'favorite',
      })
      setLocalFavoriteSynced(record, record.desiredState === 'favorite')
      synced += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      markFavoriteSyncState(record.source, record.songmid, 'failed', message)
      errors.push({ songmid: record.songmid, error: message })
    }
  }

  return {
    synced,
    failed: errors.length,
    total: pending.length,
    errors,
  }
}

export async function pullRemoteFavorites(input: { cookie?: string; page?: number; limit?: number } = {}): Promise<{
  source: 'local'
  list: FavoriteRecord[]
  pulled: number
}> {
  const pageLimit = input.limit ?? 100
  const remote = await getQQFavoriteSongs({ cookie: input.cookie, page: input.page ?? 1, limit: pageLimit })
  return {
    source: 'local',
    list: reconcileLocalFavoritesFromRemote(remote.list as MusicInfo[]),
    pulled: remote.list.length,
  }
}
