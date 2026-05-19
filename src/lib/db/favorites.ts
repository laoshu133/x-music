import { db } from '@/lib/db'
import { ensureTrack } from '@/lib/cache/store'
import type { MusicInfo, OnlineSource } from '@/lib/types'

export type FavoriteDesiredState = 'favorite' | 'unfavorite'
export type FavoriteSyncState = 'pending' | 'synced' | 'failed'

export interface FavoriteRecord {
  source: OnlineSource
  songmid: string
  name: string
  singer: string
  albumName?: string
  albumId?: string
  interval?: string
  img?: string
  desiredState: FavoriteDesiredState
  syncState: FavoriteSyncState
  error?: string
  updatedAt: string
}

interface FavoriteRow {
  source: OnlineSource
  songmid: string
  name: string
  singer: string
  album_name: string | null
  album_id: string | null
  interval: string | null
  image_url: string | null
  desired_state: FavoriteDesiredState
  sync_state: FavoriteSyncState
  error: string | null
  updated_at: string
}

export interface FavoriteSummary {
  favoriteCount: number
  pendingCount: number
  failedCount: number
}

export const listLocalFavorites = (): FavoriteRecord[] => {
  const rows = db.prepare(`
    SELECT
      t.source,
      t.songmid,
      t.name,
      t.singer,
      t.album_name,
      t.album_id,
      t.interval,
      t.image_url,
      fs.desired_state,
      fs.sync_state,
      fs.error,
      fs.updated_at
    FROM favorite_sync fs
    INNER JOIN tracks t ON t.id = fs.track_id
    WHERE fs.desired_state = 'favorite'
    ORDER BY fs.updated_at DESC, fs.id DESC
  `).all() as FavoriteRow[]

  return rows.map(mapFavorite)
}

export const getFavoriteStatus = (source: OnlineSource, songmid: string): {
  favorite: boolean
  syncState: FavoriteSyncState | null
  desiredState: FavoriteDesiredState | null
  pending: boolean
  error?: string
} => {
  const row = db.prepare(`
    SELECT fs.desired_state, fs.sync_state, fs.error
    FROM favorite_sync fs
    INNER JOIN tracks t ON t.id = fs.track_id
    WHERE t.source = ? AND t.songmid = ?
  `).get(source, songmid) as Pick<FavoriteRow, 'desired_state' | 'sync_state' | 'error'> | undefined

  if (!row) {
    return { favorite: false, syncState: null, desiredState: null, pending: false }
  }

  return {
    favorite: row.desired_state === 'favorite',
    syncState: row.sync_state,
    desiredState: row.desired_state,
    pending: row.sync_state === 'pending',
    error: row.error ?? undefined,
  }
}

export const setLocalFavorite = (musicInfo: MusicInfo, favorite: boolean): FavoriteRecord => {
  const track = ensureTrack(musicInfo)
  const desiredState: FavoriteDesiredState = favorite ? 'favorite' : 'unfavorite'

  db.prepare(`
    INSERT INTO favorite_sync (track_id, desired_state, sync_state, error, updated_at)
    VALUES (@trackId, @desiredState, 'pending', NULL, CURRENT_TIMESTAMP)
    ON CONFLICT(track_id) DO UPDATE SET
      desired_state = excluded.desired_state,
      sync_state = 'pending',
      error = NULL,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    trackId: track.id,
    desiredState,
  })

  const record = getFavoriteRecord(musicInfo.source, musicInfo.songmid)
  if (!record) throw new Error('Failed to load favorite state')
  return record
}

export const getFavoriteSummary = (): FavoriteSummary => {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN desired_state = 'favorite' THEN 1 ELSE 0 END) AS favorite_count,
      SUM(CASE WHEN sync_state = 'pending' THEN 1 ELSE 0 END) AS pending_count,
      SUM(CASE WHEN sync_state = 'failed' THEN 1 ELSE 0 END) AS failed_count
    FROM favorite_sync
  `).get() as { favorite_count: number | null; pending_count: number | null; failed_count: number | null }

  return {
    favoriteCount: row.favorite_count ?? 0,
    pendingCount: row.pending_count ?? 0,
    failedCount: row.failed_count ?? 0,
  }
}

const getFavoriteRecord = (source: OnlineSource, songmid: string): FavoriteRecord | null => {
  const row = db.prepare(`
    SELECT
      t.source,
      t.songmid,
      t.name,
      t.singer,
      t.album_name,
      t.album_id,
      t.interval,
      t.image_url,
      fs.desired_state,
      fs.sync_state,
      fs.error,
      fs.updated_at
    FROM favorite_sync fs
    INNER JOIN tracks t ON t.id = fs.track_id
    WHERE t.source = ? AND t.songmid = ?
  `).get(source, songmid) as FavoriteRow | undefined

  return row ? mapFavorite(row) : null
}

const mapFavorite = (row: FavoriteRow): FavoriteRecord => ({
  source: row.source,
  songmid: row.songmid,
  name: row.name,
  singer: row.singer,
  albumName: row.album_name ?? undefined,
  albumId: row.album_id ?? undefined,
  interval: row.interval ?? undefined,
  img: row.image_url ?? undefined,
  desiredState: row.desired_state,
  syncState: row.sync_state,
  error: row.error ?? undefined,
  updatedAt: row.updated_at,
})
