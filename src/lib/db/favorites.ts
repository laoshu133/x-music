import { db } from '@/lib/db'
import { normalizeDbDateTime, normalizeNullableDbDateTime } from '@/lib/db/time'
import { ensureTrack } from '@/lib/cache/store'
import type { MusicInfo, OnlineSource } from '@/lib/types'

export type FavoriteDesiredState = 'favorite' | 'unfavorite'
export type FavoriteSyncState = 'pending' | 'synced' | 'failed'

export interface FavoriteRecord extends MusicInfo {
  desiredState: FavoriteDesiredState
  syncState: FavoriteSyncState
  error?: string
  attempts: number
  nextRetryAt?: string
  lastAttemptAt?: string
  updatedAt: string
}

export interface FavoriteSummary { favoriteCount: number; pendingCount: number; failedCount: number }
export interface FavoriteSyncResult { synced: number; failed: number; total: number; errors: Array<{ songmid: string; error: string }> }
export interface FavoriteSyncFailureResult {
  record?: FavoriteRecord
  attempts: number
  terminal: boolean
  nextRetryAt?: string
}
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
  attempts: number
  next_retry_at: string | null
  last_attempt_at: string | null
  updated_at: string
}

const favoriteSelect = `
  SELECT t.source, t.songmid, t.name, t.singer, t.album_name, t.album_id,
         t.interval, t.image_url, t.raw_json, uf.desired_state, uf.sync_state,
         uf.error, uf.attempts, uf.next_retry_at, uf.last_attempt_at, uf.updated_at
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
    INSERT INTO user_favorites (
      user_id, track_id, desired_state, sync_state, error, attempts, next_retry_at, last_attempt_at, updated_at
    )
    VALUES (
      @userId, @trackId, @desiredState, @syncState, NULL, 0, NULL,
      CASE WHEN @syncState = 'synced' THEN CURRENT_TIMESTAMP ELSE NULL END,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(user_id, track_id) DO UPDATE SET
      desired_state = excluded.desired_state,
      sync_state = excluded.sync_state,
      error = NULL,
      attempts = 0,
      next_retry_at = NULL,
      last_attempt_at = excluded.last_attempt_at,
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
    UPDATE user_favorites
    SET sync_state = @syncState,
        error = @error,
        attempts = 0,
        next_retry_at = NULL,
        last_attempt_at = CASE WHEN @syncState = 'synced' THEN CURRENT_TIMESTAMP ELSE last_attempt_at END,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = @userId AND track_id = (SELECT id FROM tracks WHERE source = @source AND songmid = @songmid)
  `).run({ userId, source, songmid, syncState, error: error ?? null })
}

export const listPendingFavoriteSync = (userId: string, limit = 50): FavoriteRecord[] =>
  listFavoriteSyncCandidates(userId, { limit })

export const listFavoriteSyncCandidates = (
  userId: string,
  options: { limit?: number; includeFailed?: boolean; includeFuture?: boolean } = {},
): FavoriteRecord[] => {
  const states = options.includeFailed ? "('pending', 'failed')" : "('pending')"
  const dueClause = options.includeFuture ? '' : 'AND (uf.next_retry_at IS NULL OR uf.next_retry_at <= CURRENT_TIMESTAMP)'
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200)
  return (db.prepare(`
    ${favoriteSelect}
    WHERE uf.user_id = ?
      AND uf.sync_state IN ${states}
      ${dueClause}
    ORDER BY COALESCE(uf.next_retry_at, uf.updated_at) ASC
    LIMIT ?
  `).all(userId, limit) as FavoriteRow[]).map(mapFavorite)
}

export const completeFavoriteSyncAttempt = (
  userId: string,
  source: OnlineSource,
  songmid: string,
  desiredState: FavoriteDesiredState,
): FavoriteRecord | undefined => {
  const result = db.prepare(`
    UPDATE user_favorites
    SET sync_state = 'synced',
        error = NULL,
        attempts = 0,
        next_retry_at = NULL,
        last_attempt_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = @userId
      AND desired_state = @desiredState
      AND track_id = (SELECT id FROM tracks WHERE source = @source AND songmid = @songmid)
      AND sync_state IN ('pending', 'failed')
  `).run({ userId, source, songmid, desiredState })
  return result.changes ? getFavoriteRecord(userId, source, songmid) : undefined
}

export const failFavoriteSyncAttempt = (input: {
  userId: string
  source: OnlineSource
  songmid: string
  desiredState: FavoriteDesiredState
  error: string
  retryable: boolean
  maxAttempts: number
  retryDelaySeconds: number
}): FavoriteSyncFailureResult => {
  return db.transaction(() => {
    const current = db.prepare(`
      SELECT uf.attempts
      FROM user_favorites uf
      INNER JOIN tracks t ON t.id = uf.track_id
      WHERE uf.user_id = @userId
        AND uf.desired_state = @desiredState
        AND uf.sync_state IN ('pending', 'failed')
        AND t.source = @source
        AND t.songmid = @songmid
    `).get(input) as { attempts: number } | undefined
    if (!current) return { attempts: 0, terminal: true }

    const attempts = current.attempts + 1
    const terminal = !input.retryable || attempts >= Math.max(1, input.maxAttempts)
    const delay = terminal ? null : `+${Math.max(1, Math.trunc(input.retryDelaySeconds))} seconds`
    db.prepare(`
      UPDATE user_favorites
      SET sync_state = @syncState,
          error = @error,
          attempts = @attempts,
          next_retry_at = @nextRetryAt,
          last_attempt_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = @userId
        AND desired_state = @desiredState
        AND track_id = (SELECT id FROM tracks WHERE source = @source AND songmid = @songmid)
        AND sync_state IN ('pending', 'failed')
    `).run({
      ...input,
      syncState: terminal ? 'failed' : 'pending',
      attempts,
      nextRetryAt: delay
        ? (db.prepare("SELECT datetime('now', ?) AS value").get(delay) as { value: string }).value
        : null,
    })

    const record = getFavoriteRecord(input.userId, input.source, input.songmid)
    return {
      record,
      attempts,
      terminal,
      nextRetryAt: record?.nextRetryAt,
    }
  })()
}

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
    attempts: row.attempts,
    nextRetryAt: normalizeNullableDbDateTime(row.next_retry_at) ?? undefined,
    lastAttemptAt: normalizeNullableDbDateTime(row.last_attempt_at) ?? undefined,
    updatedAt: normalizeDbDateTime(row.updated_at),
  }
}

function resolveTestUserId(userId?: string): string | undefined {
  if (userId || process.env.NODE_ENV !== 'test') return userId
  return (db.prepare("SELECT value FROM app_meta WHERE key = 'test.current_qq_user_id'").get() as { value?: string } | undefined)?.value
}
