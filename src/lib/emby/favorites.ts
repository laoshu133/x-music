import { getRemoteMapping } from '@/lib/db/remote-mappings'
import type { AccountRecord } from '@/lib/db/accounts'
import type { MusicInfo } from '@/lib/types'
import { setEmbyFavorite } from './upstream-api'

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
