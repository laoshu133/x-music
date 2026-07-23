import { db } from '@/lib/db'
import { normalizeDbDateTime } from '@/lib/db/time'
import { ensureTrack } from '@/lib/cache/store'
import type { MusicInfo, OnlineSource } from '@/lib/types'

export type FavoriteDesiredState = 'favorite' | 'unfavorite'
export type FavoriteSyncState = 'pending' | 'synced' | 'failed'

export interface FavoriteRecord extends MusicInfo {
  desiredState: FavoriteDesiredState
  syncState: FavoriteSyncState
  error?: string
  updatedAt: string
}

export interface FavoriteSummary { favoriteCount: number; pendingCount: number; failedCount: number }
export interface FavoriteSyncResult { synced: number; failed: number; total: number; errors: Array<{ songmid: string; error: string }> }
type FavoriteStatus = { favorite: boolean; syncState: FavoriteSyncState | null; desiredState: FavoriteDesiredState | null; pending: boolean; error?: string }

interface FavoriteRow {
  source: OnlineSource
  songmid: string
  name: string
  singer: string
  album_name: string | null
  album_id: string | null
  interval: string | null
  image_url: string | null
  raw_json: string | null
  desired_state: FavoriteDesiredState
  sync_state: FavoriteSyncState
  error: string | null
  updated_at: string
}

const favoriteSelect = `
  SELECT t.source, t.songmid, t.name, t.singer, t.album_name, t.album_id,
         t.interval, t.image_url, t.raw_json, uf.desired_state, uf.sync_state,
         uf.error, uf.updated_at
  FROM user_favorites uf INNER JOIN tracks t ON t.id = uf.track_id
`

export const listLocalFavorites = (userId: string): FavoriteRecord[] => listLocalFavoritesForAccount(userId)

export const getFavoriteStatus = (source: OnlineSource, songmid: string, userId?: string): FavoriteStatus =>
  getFavoriteStatusForAccount(source, songmid, userId)

export const getFavoriteStatusForAccount = (source: OnlineSource, songmid: string, userId?: string): FavoriteStatus => {
  userId = resolveTestUserId(userId)
  if (!userId) return emptyStatus()
  const row = db.prepare(`
    SELECT uf.desired_state, uf.sync_state, uf.error
    FROM user_favorites uf INNER JOIN tracks t ON t.id = uf.track_id
    WHERE uf.user_id = ? AND t.source = ? AND t.songmid = ?
  `).get(userId, source, songmid) as Pick<FavoriteRow, 'desired_state' | 'sync_state' | 'error'> | undefined
  return row ? favoriteStatusFromRow(row) : emptyStatus()
}

export const listLocalFavoritesForAccount = (userId?: string): FavoriteRecord[] => {
  userId = resolveTestUserId(userId)
  if (!userId) return []
  return (db.prepare(`${favoriteSelect} WHERE uf.user_id = ? ORDER BY uf.updated_at DESC`).all(userId) as FavoriteRow[]).map(mapFavorite)
}

export const setLocalFavorite = (musicInfo: MusicInfo, favorite: boolean, userId?: string): FavoriteRecord =>
  writeFavorite(musicInfo, favorite, 'pending', userId)

export const setLocalFavoriteSynced = (musicInfo: MusicInfo, favorite: boolean, userId?: string): FavoriteRecord =>
  writeFavorite(musicInfo, favorite, 'synced', userId)

function writeFavorite(musicInfo: MusicInfo, favorite: boolean, syncState: FavoriteSyncState, userId?: string): FavoriteRecord {
  userId = resolveTestUserId(userId)
  if (!userId) throw new Error('User is required for favorite state')
  const track = ensureTrack(musicInfo)
  const desiredState: FavoriteDesiredState = favorite ? 'favorite' : 'unfavorite'
  db.prepare(`
    INSERT INTO user_favorites (user_id, track_id, desired_state, sync_state, error, updated_at)
    VALUES (@userId, @trackId, @desiredState, @syncState, NULL, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, track_id) DO UPDATE SET
      desired_state = excluded.desired_state,
      sync_state = excluded.sync_state,
      error = NULL,
      updated_at = CURRENT_TIMESTAMP
  `).run({ userId, trackId: track.id, desiredState, syncState })
  return getFavoriteRecord(userId, musicInfo.source, musicInfo.songmid)!
}

export const markFavoriteSyncState = (
  userId: string,
  source: OnlineSource,
  songmid: string,
  syncState: FavoriteSyncState,
  error?: string,
): void => {
  db.prepare(`
    UPDATE user_favorites SET sync_state = @syncState, error = @error, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = @userId AND track_id = (SELECT id FROM tracks WHERE source = @source AND songmid = @songmid)
  `).run({ userId, source, songmid, syncState, error: error ?? null })
}

export const listPendingFavoriteSync = (userId: string, limit = 50): FavoriteRecord[] =>
  (db.prepare(`${favoriteSelect} WHERE uf.user_id = ? AND uf.sync_state IN ('pending', 'failed') ORDER BY uf.updated_at ASC LIMIT ?`).all(userId, limit) as FavoriteRow[]).map(mapFavorite)

export const reconcileLocalFavoritesFromRemote = (userId: string, remoteSongs: MusicInfo[]): FavoriteRecord[] => {
  const remoteKeys = new Set(remoteSongs.map(song => `${song.source}:${song.songmid}`))
  const local = listLocalFavorites(userId)
  db.transaction(() => {
    for (const song of remoteSongs) setLocalFavoriteSynced(song, true, userId)
    for (const item of local) {
      if (!remoteKeys.has(`${item.source}:${item.songmid}`) && item.syncState !== 'pending') setLocalFavoriteSynced(item, false, userId)
    }
  })()
  return listLocalFavorites(userId)
}

export const getFavoriteSummary = (userId: string): FavoriteSummary => {
  const row = db.prepare(`
    SELECT SUM(desired_state = 'favorite') AS favorite_count,
           SUM(sync_state = 'pending') AS pending_count,
           SUM(sync_state = 'failed') AS failed_count
    FROM user_favorites WHERE user_id = ?
  `).get(userId) as { favorite_count: number | null; pending_count: number | null; failed_count: number | null }
  return { favoriteCount: row.favorite_count ?? 0, pendingCount: row.pending_count ?? 0, failedCount: row.failed_count ?? 0 }
}

function getFavoriteRecord(userId: string, source: OnlineSource, songmid: string): FavoriteRecord | undefined {
  const row = db.prepare(`${favoriteSelect} WHERE uf.user_id = ? AND t.source = ? AND t.songmid = ?`).get(userId, source, songmid) as FavoriteRow | undefined
  return row ? mapFavorite(row) : undefined
}

function emptyStatus(): FavoriteStatus { return { favorite: false, syncState: null, desiredState: null, pending: false } }
function favoriteStatusFromRow(row: Pick<FavoriteRow, 'desired_state' | 'sync_state' | 'error'>): FavoriteStatus {
  return { favorite: row.desired_state === 'favorite', syncState: row.sync_state, desiredState: row.desired_state, pending: row.sync_state === 'pending', error: row.error ?? undefined }
}

function mapFavorite(row: FavoriteRow): FavoriteRecord {
  return {
    source: row.source,
    songmid: row.songmid,
    name: row.name,
    singer: row.singer,
    albumName: row.album_name ?? undefined,
    albumId: row.album_id ?? undefined,
    interval: row.interval ?? undefined,
    img: row.image_url ?? undefined,
    raw: row.raw_json ? JSON.parse(row.raw_json) : undefined,
    desiredState: row.desired_state,
    syncState: row.sync_state,
    error: row.error ?? undefined,
    updatedAt: normalizeDbDateTime(row.updated_at),
  }
}

function resolveTestUserId(userId?: string): string | undefined {
  if (userId || process.env.NODE_ENV !== 'test') return userId
  return (db.prepare("SELECT value FROM app_meta WHERE key = 'test.current_qq_user_id'").get() as { value?: string } | undefined)?.value
}
