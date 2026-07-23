import { db } from '@/lib/db'
import { normalizeDbDateTime, normalizeOptionalDbDateTime } from '@/lib/db/time'
import { buildQQLoginState, parseQQAccessTokenExpiresAt, type QQLoginState } from '@/lib/qq/account'
import { getQQFavoriteSongs } from '@/lib/qq/favorites'
import { getQQUserProfile } from '@/lib/qq/user'
import { decryptSecret, encryptSecret } from '@/lib/security'
import { getUserById, isAdminUser, listUsers, markUserActive, markUserLogin, type UserRole, type UserStatus } from '@/lib/db/users'
import type { MusicInfo, MusicQuality } from '@/lib/types'

export interface AccountRecord {
  userId: string
  username: string
  role: UserRole
  status: UserStatus
  displayName?: string
  qqUin: string
  qqNickname?: string
  qqCookie: string
  encryptedUin?: string
  qqmusicKey?: string
  qqAuthState: 'missing' | 'active' | 'expired'
  qqAuthCheckedAt?: string
  qqAuthError?: string
  embyUserId?: string
  embyUsername: string
  embyPassword: string
  embyAccessToken?: string
  embyDsn?: string
  embySourceWebdavDsn?: string
  embyProxyTimeoutMs?: number
  lastLoginAt?: string
  lastLoginIp?: string
  lastActiveAt?: string
  createdAt: string
  updatedAt: string
}

export interface AccountListItem {
  userId: string
  username: string
  role: UserRole
  status: UserStatus
  qqUin?: string
  qqNickname?: string
  embyUsername: string
  embyUserId?: string
  isAdmin: boolean
  playCount: number
  favoriteCount: number
  createdAt: string
  updatedAt: string
  lastLoginAt?: string
  lastLoginIp?: string
  lastActiveAt?: string
}

interface AccountRow {
  user_id: string
  username: string
  role: UserRole
  status: UserStatus
  display_name: string | null
  qq_uin: string | null
  qq_nickname: string | null
  encrypted_cookie: string | null
  encrypted_uin: string | null
  qqmusic_key: string | null
  auth_state: string | null
  auth_checked_at: string | null
  auth_error: string | null
  upstream_user_id: string | null
  player_password_encrypted: string
  upstream_access_token: string | null
  upstream_dsn: string | null
  source_webdav_dsn: string | null
  proxy_timeout_ms: number | null
  last_login_at: string | null
  last_login_ip: string | null
  last_active_at: string | null
  created_at: string
  updated_at: string
}

export interface AccountTrackItem extends MusicInfo {
  quality?: MusicQuality
  playedAt?: string
  favoriteUpdatedAt?: string
  syncState?: string
}

export interface AccountTrackPage {
  page: number
  limit: number
  total: number
  items: AccountTrackItem[]
}

export interface AccountDetail {
  account: AccountListItem & {
    encryptedUin?: string
    hasQQMusicKey: boolean
    hasEmbyPassword: boolean
    hasEmbyAccessToken: boolean
    embyDsn?: string
    hasEmbySourceWebdavDsn: boolean
    embyProxyTimeoutMs?: number
  }
  qq: ReturnType<typeof summarizeAccountQQ>
  favorites: {
    source: 'qq' | 'local'
    total: number
    items: AccountTrackItem[]
    page?: number
    limit?: number
    error?: string
  }
  recentPlays: AccountTrackPage
}

export type AccountProfile = Pick<AccountDetail, 'account' | 'qq'>
export type AccountFavorites = AccountDetail['favorites']

const accountSelect = `
  SELECT
    u.id AS user_id,
    u.username,
    u.role,
    u.status,
    u.display_name,
    u.last_login_at,
    u.last_login_ip,
    u.last_active_at,
    u.created_at,
    u.updated_at,
    q.qq_uin,
    q.qq_nickname,
    q.encrypted_cookie,
    q.encrypted_uin,
    q.qqmusic_key,
    q.auth_state,
    q.auth_checked_at,
    q.auth_error,
    e.upstream_user_id,
    e.player_password_encrypted,
    e.upstream_access_token,
    e.upstream_dsn,
    e.source_webdav_dsn,
    e.proxy_timeout_ms
  FROM users u
  INNER JOIN user_emby_profiles e ON e.user_id = u.id
  LEFT JOIN qq_authorizations q ON q.user_id = u.id
`

export function bindQQAuthorization(userId: string, cookieText: string): AccountRecord {
  if (!getUserById(userId)) throw new Error('User not found')
  const state = buildQQLoginState(cookieText, 'stored')
  try {
    db.prepare(`
      INSERT INTO qq_authorizations (
        user_id, qq_uin, encrypted_cookie, encrypted_uin, qqmusic_key,
        auth_state, auth_checked_at, auth_error, updated_at
      ) VALUES (
        @userId, @qqUin, @encryptedCookie, @encryptedUin, @qqmusicKey,
        'active', CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP
      )
      ON CONFLICT(user_id) DO UPDATE SET
        qq_uin = excluded.qq_uin,
        encrypted_cookie = excluded.encrypted_cookie,
        encrypted_uin = excluded.encrypted_uin,
        qqmusic_key = excluded.qqmusic_key,
        auth_state = 'active',
        auth_checked_at = CURRENT_TIMESTAMP,
        auth_error = NULL,
        credential_version = qq_authorizations.credential_version + 1,
        updated_at = CURRENT_TIMESTAMP
    `).run({
      userId,
      qqUin: state.uin,
      encryptedCookie: encryptSecret(state.cookie),
      encryptedUin: state.encryptedUin ?? null,
      qqmusicKey: state.qqmusicKey ?? null,
    })
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed: qq_authorizations.qq_uin')) {
      throw new Error('QQ_ALREADY_BOUND')
    }
    throw error
  }
  return getAccountByUserId(userId)!
}

export function getAccountByUserId(userId: string): AccountRecord | undefined {
  const row = db.prepare(`${accountSelect} WHERE u.id = ?`).get(userId) as AccountRow | undefined
  return row ? rowToAccount(row) : undefined
}

export function getAccountByQQ(qqUin: string): AccountRecord | undefined {
  const row = db.prepare(`${accountSelect} WHERE q.qq_uin = ?`).get(qqUin) as AccountRow | undefined
  return row ? rowToAccount(row) : undefined
}

export function getAccountByEmbyUsername(username: string): AccountRecord | undefined {
  const row = db.prepare(`${accountSelect} WHERE u.username = ? COLLATE NOCASE`).get(username) as AccountRow | undefined
  return row ? rowToAccount(row) : undefined
}

export function getAccountByEmbyUserId(embyUserId: string): AccountRecord | undefined {
  const row = db.prepare(`${accountSelect} WHERE e.upstream_user_id = ?`).get(embyUserId) as AccountRow | undefined
  return row ? rowToAccount(row) : undefined
}

export function listAccounts(): AccountRecord[] {
  return (db.prepare(`${accountSelect} ORDER BY u.created_at ASC`).all() as AccountRow[]).map(rowToAccount)
}

export function listAccountSummaries(): AccountListItem[] {
  return listAccounts().map(account => ({
    userId: account.userId,
    username: account.username,
    role: account.role,
    status: account.status,
    qqUin: account.qqUin || undefined,
    qqNickname: account.qqNickname,
    embyUsername: account.embyUsername,
    embyUserId: account.embyUserId,
    isAdmin: account.role === 'admin',
    playCount: countAccountRecentPlays(account.userId),
    favoriteCount: countAccountFavorites(account.userId),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastLoginAt: account.lastLoginAt,
    lastLoginIp: account.lastLoginIp,
    lastActiveAt: account.lastActiveAt,
  }))
}

export async function getAccountDetail(userId: string): Promise<AccountDetail | undefined> {
  const profile = getAccountProfile(userId)
  if (!profile) return undefined
  const favorites = await getAccountFavorites(userId, 1, 50)
  const recentPlays = getAccountRecentPlays(userId, 1, 50)
  if (!favorites || !recentPlays) return undefined
  return { ...profile, favorites, recentPlays }
}

export function getAccountProfile(userId: string): AccountProfile | undefined {
  const account = getAccountByUserId(userId)
  if (!account) return undefined
  const summary = listAccountSummaries().find(item => item.userId === userId)!
  return {
    account: {
      ...summary,
      encryptedUin: account.encryptedUin,
      hasQQMusicKey: Boolean(account.qqmusicKey),
      hasEmbyPassword: Boolean(account.embyPassword),
      hasEmbyAccessToken: Boolean(account.embyAccessToken),
      embyDsn: account.embyDsn,
      hasEmbySourceWebdavDsn: Boolean(account.embySourceWebdavDsn),
      embyProxyTimeoutMs: account.embyProxyTimeoutMs,
    },
    qq: summarizeAccountQQ(account),
  }
}

export async function getAccountFavorites(userId: string, page = 1, limit = 50): Promise<AccountFavorites | undefined> {
  const account = getAccountByUserId(userId)
  if (!account) return undefined
  const normalizedPage = normalizePage(page)
  const normalizedLimit = normalizeLimit(limit)
  const local = listAccountLocalFavorites(userId, normalizedPage, normalizedLimit)
  if (account.qqAuthState !== 'active') {
    return { source: 'local', total: countAccountFavorites(userId), items: local, page: normalizedPage, limit: normalizedLimit }
  }
  try {
    const remote = await getQQFavoriteSongs({ cookie: account.qqCookie, page: normalizedPage, limit: normalizedLimit })
    const seen = new Set(remote.list.map(item => `${item.source}:${item.songmid}`))
    const items = [...remote.list, ...local.filter(item => !seen.has(`${item.source}:${item.songmid}`))]
    return { source: 'qq', total: Math.max(remote.total, items.length), items, page: normalizedPage, limit: normalizedLimit }
  } catch (error) {
    return {
      source: 'local',
      total: countAccountFavorites(userId),
      items: local,
      page: normalizedPage,
      limit: normalizedLimit,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function getAccountRecentPlays(userId: string, page = 1, limit = 50): AccountTrackPage | undefined {
  if (!getUserById(userId)) return undefined
  const normalizedPage = normalizePage(page)
  const normalizedLimit = normalizeLimit(limit)
  return {
    page: normalizedPage,
    limit: normalizedLimit,
    total: countAccountRecentPlays(userId),
    items: listAccountRecentPlays(userId, normalizedPage, normalizedLimit),
  }
}

export function markAccountActive(userId: string): void {
  markUserActive(userId)
}

/** @deprecated Test-only compatibility for the removed QQ-based administrator model. */
export function isAdminQQ(qqUin: string | undefined): boolean {
  if (process.env.NODE_ENV !== 'test' || !qqUin) return false
  return (process.env.ADMIN_QQ_UINS ?? '').split(/[,;\s]+/).map(value => value.replace(/^o/i, '')).includes(qqUin.replace(/^o/i, ''))
}

export function markAccountLogin(userId: string, loginIp?: string): void {
  markUserLogin(userId, loginIp)
}

export function markAccountQQAuthChecked(userId: string): void {
  db.prepare(`UPDATE qq_authorizations SET auth_state = 'active', auth_checked_at = CURRENT_TIMESTAMP, auth_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`).run(userId)
}

export function markAccountQQAuthExpired(userId: string, error?: string): void {
  db.prepare(`UPDATE qq_authorizations SET auth_state = 'expired', auth_checked_at = CURRENT_TIMESTAMP, auth_error = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`).run(error ?? null, userId)
}

export async function refreshAccountQQProfile(userId: string): Promise<AccountRecord | undefined> {
  const account = getAccountByUserId(userId)
  if (!account?.qqUin) return account
  const profile = await getQQUserProfile({ uin: account.qqUin, cookie: account.qqCookie }).catch(() => undefined)
  if (profile?.nickname) updateAccountQQNickname(userId, profile.nickname)
  return getAccountByUserId(userId)
}

export function updateAccountQQNickname(userId: string, nickname: string): AccountRecord | undefined {
  const normalized = nickname.trim()
  if (normalized) db.prepare('UPDATE qq_authorizations SET qq_nickname = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(normalized, userId)
  return getAccountByUserId(userId)
}

export function updateAccountQQCookie(userId: string, cookieText: string): AccountRecord | undefined {
  const current = getAccountByUserId(userId)
  const state = buildQQLoginState(cookieText, 'stored')
  if (!current?.qqUin || current.qqUin !== state.uin) throw new Error('Refreshed QQ authorization belongs to a different QQ account')
  db.prepare(`
    UPDATE qq_authorizations
    SET encrypted_cookie = @cookie, encrypted_uin = @encryptedUin, qqmusic_key = @qqmusicKey,
        auth_state = 'active', auth_checked_at = CURRENT_TIMESTAMP, auth_error = NULL,
        credential_version = credential_version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = @userId
  `).run({ userId, cookie: encryptSecret(state.cookie), encryptedUin: state.encryptedUin ?? null, qqmusicKey: state.qqmusicKey ?? null })
  return getAccountByUserId(userId)
}

export function updateAccountEmbyAuth(input: { userId: string; embyUserId?: string; embyAccessToken?: string }): void {
  db.prepare(`
    UPDATE user_emby_profiles
    SET upstream_user_id = COALESCE(@embyUserId, upstream_user_id),
        upstream_access_token = COALESCE(@embyAccessToken, upstream_access_token),
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = @userId
  `).run({ userId: input.userId, embyUserId: input.embyUserId ?? null, embyAccessToken: input.embyAccessToken ?? null })
}

export function updateAccountEmbyPassword(userId: string, password: string): AccountRecord | undefined {
  const normalized = password.trim()
  if (normalized) db.prepare('UPDATE user_emby_profiles SET player_password_encrypted = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(encryptSecret(normalized), userId)
  return getAccountByUserId(userId)
}

export function updateAccountEmbyConfig(
  userId: string,
  input: { password?: string; dsn?: string | null; sourceWebdavDsn?: string | null; proxyTimeoutMs?: number | null },
): AccountRecord | undefined {
  const current = getAccountByUserId(userId)
  if (!current) return undefined
  const password = input.password?.trim() || current.embyPassword
  db.prepare(`
    UPDATE user_emby_profiles
    SET player_password_encrypted = @password,
        upstream_dsn = @dsn,
        source_webdav_dsn = @sourceWebdavDsn,
        proxy_timeout_ms = @proxyTimeoutMs,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = @userId
  `).run({
    userId,
    password: encryptSecret(password),
    dsn: normalizeOptionalUrl(input.dsn, current.embyDsn),
    sourceWebdavDsn: normalizeOptionalUrl(input.sourceWebdavDsn, current.embySourceWebdavDsn),
    proxyTimeoutMs: normalizeProxyTimeout(input.proxyTimeoutMs, current.embyProxyTimeoutMs),
  })
  return getAccountByUserId(userId)
}

export function accountToQQLoginState(account: AccountRecord): QQLoginState {
  if (!account.qqUin || !account.qqCookie) throw new Error('QQ authorization is required')
  return {
    cookie: account.qqCookie,
    uin: account.qqUin,
    encryptedUin: account.encryptedUin,
    qqmusicKey: account.qqmusicKey,
    accessTokenExpiresAt: parseQQAccessTokenExpiresAt(account.qqCookie),
    source: 'stored',
  }
}

export function summarizeAccount(account: AccountRecord) {
  return {
    loggedIn: true,
    user: { id: account.userId, username: account.username, role: account.role, status: account.status },
    username: account.username,
    isAdmin: account.role === 'admin',
    qq: summarizeAccountQQ(account),
    emby: account.qqAuthState === 'active' ? {
      username: account.username,
      hasPassword: Boolean(account.embyPassword),
      userId: account.embyUserId,
      hasAccessToken: Boolean(account.embyAccessToken),
      dsn: account.embyDsn,
      hasSourceWebdavDsn: Boolean(account.embySourceWebdavDsn),
      proxyTimeoutMs: account.embyProxyTimeoutMs,
    } : undefined,
  }
}

function summarizeAccountQQ(account: AccountRecord) {
  return {
    authorized: account.qqAuthState === 'active',
    status: account.qqAuthState,
    uin: account.qqUin || undefined,
    nickname: account.qqNickname,
    hasEncryptedUin: Boolean(account.encryptedUin),
    hasQQMusicKey: Boolean(account.qqmusicKey),
    accessTokenExpiresAt: account.qqCookie ? parseQQAccessTokenExpiresAt(account.qqCookie) : undefined,
    error: account.qqAuthError,
  }
}

function rowToAccount(row: AccountRow): AccountRecord {
  return {
    userId: row.user_id,
    username: row.username,
    role: row.role,
    status: row.status,
    displayName: row.display_name ?? undefined,
    qqUin: row.qq_uin ?? '',
    qqNickname: row.qq_nickname ?? undefined,
    qqCookie: row.encrypted_cookie ? decryptSecret(row.encrypted_cookie) : '',
    encryptedUin: row.encrypted_uin ?? undefined,
    qqmusicKey: row.qqmusic_key ?? undefined,
    qqAuthState: row.qq_uin ? (row.auth_state === 'expired' ? 'expired' : 'active') : 'missing',
    qqAuthCheckedAt: normalizeOptionalDbDateTime(row.auth_checked_at),
    qqAuthError: row.auth_error ?? undefined,
    embyUserId: row.upstream_user_id ?? undefined,
    embyUsername: row.username,
    embyPassword: decryptSecret(row.player_password_encrypted),
    embyAccessToken: row.upstream_access_token ?? undefined,
    embyDsn: row.upstream_dsn ?? undefined,
    embySourceWebdavDsn: row.source_webdav_dsn ?? undefined,
    embyProxyTimeoutMs: row.proxy_timeout_ms ?? undefined,
    lastLoginAt: normalizeOptionalDbDateTime(row.last_login_at),
    lastLoginIp: row.last_login_ip ?? undefined,
    lastActiveAt: normalizeOptionalDbDateTime(row.last_active_at),
    createdAt: normalizeDbDateTime(row.created_at),
    updatedAt: normalizeDbDateTime(row.updated_at),
  }
}

function countAccountFavorites(userId: string): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM user_favorites WHERE user_id = ? AND desired_state = 'favorite'").get(userId) as { count: number }).count
}

function listAccountLocalFavorites(userId: string, page: number, limit: number): AccountTrackItem[] {
  const rows = db.prepare(`
    SELECT t.*, uf.updated_at AS favorite_updated_at, uf.sync_state
    FROM user_favorites uf INNER JOIN tracks t ON t.id = uf.track_id
    WHERE uf.user_id = ? AND uf.desired_state = 'favorite'
    ORDER BY uf.updated_at DESC LIMIT ? OFFSET ?
  `).all(userId, limit, (page - 1) * limit) as Array<Record<string, any>>
  return rows.map(row => ({
    source: row.source,
    songmid: row.songmid,
    name: row.name,
    singer: row.singer,
    albumName: row.album_name ?? undefined,
    albumId: row.album_id ?? undefined,
    interval: row.interval ?? undefined,
    img: row.image_url ?? undefined,
    raw: parseRawJson(row.raw_json),
    favoriteUpdatedAt: normalizeDbDateTime(row.favorite_updated_at),
    syncState: row.sync_state,
  }))
}

function listAccountRecentPlays(userId: string, page: number, limit: number): AccountTrackItem[] {
  const rows = db.prepare(`
    SELECT t.*, pe.quality, pe.played_at
    FROM play_events pe INNER JOIN tracks t ON t.id = pe.track_id
    WHERE pe.user_id = ? ORDER BY pe.played_at DESC, pe.id DESC LIMIT ? OFFSET ?
  `).all(userId, limit, (page - 1) * limit) as Array<Record<string, any>>
  return rows.map(row => ({
    source: row.source,
    songmid: row.songmid,
    name: row.name,
    singer: row.singer,
    albumName: row.album_name ?? undefined,
    albumId: row.album_id ?? undefined,
    interval: row.interval ?? undefined,
    img: row.image_url ?? undefined,
    raw: parseRawJson(row.raw_json),
    quality: row.quality,
    playedAt: normalizeDbDateTime(row.played_at),
  }))
}

function countAccountRecentPlays(userId: string): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM play_events WHERE user_id = ?').get(userId) as { count: number }).count
}

function normalizeOptionalUrl(value: string | null | undefined, current: string | undefined): string | null {
  if (value === undefined) return current ?? null
  const trimmed = value?.trim() ?? ''
  if (!trimmed) return null
  if (trimmed.includes('********')) return current ?? null
  return trimmed.replace(/\/+$/g, '')
}

function normalizeProxyTimeout(value: number | null | undefined, current: number | undefined): number | null {
  if (value === undefined) return current ?? null
  if (value === null) return null
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : current ?? null
}

function normalizePage(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 1
}

function normalizeLimit(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.trunc(value), 100) : 50
}

function parseRawJson(value: string | null): unknown {
  if (!value) return undefined
  try { return JSON.parse(value) } catch { return undefined }
}
