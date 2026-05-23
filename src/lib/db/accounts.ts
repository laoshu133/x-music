import crypto from 'node:crypto'
import { db } from '@/lib/db'
import { buildQQLoginState, summarizeQQLoginState, type QQLoginState } from '@/lib/qq/account'
import { appConfig } from '@/lib/config'
import { getQQFavoriteSongs } from '@/lib/qq/favorites'
import { getQQUserProfile } from '@/lib/qq/user'
import type { MusicInfo, MusicQuality } from '@/lib/types'

export interface AccountRecord {
  qqUin: string
  qqNickname?: string
  qqCookie: string
  encryptedUin?: string
  qqmusicKey?: string
  embyUserId?: string
  embyUsername: string
  embyPassword: string
  embyAccessToken?: string
  lastLoginAt?: string
  lastLoginIp?: string
  lastActiveAt?: string
  createdAt: string
  updatedAt: string
}

export interface AccountListItem {
  qqUin: string
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

export interface AccountUpsertResult {
  account: AccountRecord
  generatedPassword?: string
}

interface AccountRow {
  qq_uin: string
  qq_nickname: string | null
  qq_cookie: string
  encrypted_uin: string | null
  qqmusic_key: string | null
  emby_user_id: string | null
  emby_username: string
  emby_password: string
  emby_access_token: string | null
  last_login_at: string | null
  last_login_ip: string | null
  last_active_at: string | null
  created_at: string
  updated_at: string
}

interface AccountStatsRow {
  qq_uin: string
  play_count: number
  favorite_count: number
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
  }
  qq: ReturnType<typeof summarizeQQLoginState>
  favorites: {
    source: 'qq' | 'local'
    total: number
    items: AccountTrackItem[]
    page?: number
    limit?: number
    error?: string
  }
  recentPlays: AccountTrackItem[] | AccountTrackPage
}

export type AccountProfile = Pick<AccountDetail, 'account' | 'qq'>
export type AccountFavorites = AccountDetail['favorites']

export function upsertAccountFromQQCookie(cookieText: string, options: { loginIp?: string } = {}): AccountUpsertResult {
  const state = buildQQLoginState(cookieText, 'stored')
  const existing = getAccountByQQ(state.uin)
  const embyUsername = embyUsernameForQQ(state.uin)
  const generatedPassword = existing ? undefined : generateAccountPassword()
  const embyPassword = existing?.embyPassword ?? generatedPassword!

  db.prepare(`
    INSERT INTO accounts (
      qq_uin,
      qq_nickname,
      qq_cookie,
      encrypted_uin,
      qqmusic_key,
      emby_user_id,
      emby_username,
      emby_password,
      emby_access_token,
      last_login_at,
      last_login_ip,
      last_active_at,
      updated_at
    )
    VALUES (
      @qqUin,
      @qqNickname,
      @qqCookie,
      @encryptedUin,
      @qqmusicKey,
      @embyUserId,
      @embyUsername,
      @embyPassword,
      @embyAccessToken,
      CURRENT_TIMESTAMP,
      @lastLoginIp,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(qq_uin) DO UPDATE SET
      qq_cookie = excluded.qq_cookie,
      qq_nickname = COALESCE(excluded.qq_nickname, accounts.qq_nickname),
      encrypted_uin = excluded.encrypted_uin,
      qqmusic_key = excluded.qqmusic_key,
      emby_username = excluded.emby_username,
      emby_password = excluded.emby_password,
      last_login_at = CURRENT_TIMESTAMP,
      last_login_ip = COALESCE(excluded.last_login_ip, accounts.last_login_ip),
      last_active_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    qqUin: state.uin,
    qqNickname: existing?.qqNickname ?? null,
    qqCookie: state.cookie,
    encryptedUin: state.encryptedUin ?? null,
    qqmusicKey: state.qqmusicKey ?? null,
    embyUserId: existing?.embyUserId ?? null,
    embyUsername,
    embyPassword,
    embyAccessToken: existing?.embyAccessToken ?? null,
    lastLoginIp: options.loginIp ?? null,
  })

  return {
    account: getAccountByQQ(state.uin)!,
    generatedPassword,
  }
}

export function getAccountByQQ(qqUin: string): AccountRecord | undefined {
  const row = db.prepare('SELECT * FROM accounts WHERE qq_uin = ?').get(qqUin) as AccountRow | undefined
  return row ? rowToAccount(row) : undefined
}

export function getAccountByEmbyUsername(username: string): AccountRecord | undefined {
  const row = db.prepare('SELECT * FROM accounts WHERE lower(emby_username) = lower(?)').get(username) as AccountRow | undefined
  return row ? rowToAccount(row) : undefined
}

export function getAccountByEmbyUserId(userId: string): AccountRecord | undefined {
  const row = db.prepare('SELECT * FROM accounts WHERE emby_user_id = ?').get(userId) as AccountRow | undefined
  return row ? rowToAccount(row) : undefined
}

export function listAccounts(): AccountRecord[] {
  const rows = db.prepare('SELECT * FROM accounts ORDER BY updated_at DESC').all() as AccountRow[]
  return rows.map(rowToAccount)
}

export function listAccountSummaries(): AccountListItem[] {
  const stats = accountStatsByQQ()
  return listAccounts().map(account => {
    const accountStats = stats.get(account.qqUin)
    return {
      qqUin: account.qqUin,
      qqNickname: account.qqNickname,
      embyUsername: account.embyUsername,
      embyUserId: account.embyUserId,
      isAdmin: isAdminQQ(account.qqUin),
      playCount: accountStats?.playCount ?? 0,
      favoriteCount: accountStats?.favoriteCount ?? 0,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      lastLoginAt: account.lastLoginAt,
      lastLoginIp: account.lastLoginIp,
      lastActiveAt: account.lastActiveAt,
    }
  })
}

export async function getAccountDetail(qqUin: string): Promise<AccountDetail | undefined> {
  const profile = getAccountProfile(qqUin)
  if (!profile) return undefined
  const favorites = await getAccountFavorites(qqUin, 1, 50)
  const recentPlays = getAccountRecentPlays(qqUin, 1, 50)
  if (!favorites || !recentPlays) return undefined

  return {
    ...profile,
    favorites,
    recentPlays,
  }
}

export function getAccountProfile(qqUin: string): AccountProfile | undefined {
  const account = getAccountByQQ(qqUin)
  if (!account) return undefined

  const summary = listAccountSummaries().find(item => item.qqUin === qqUin)
  if (!summary) return undefined

  return {
    account: {
      ...summary,
      encryptedUin: account.encryptedUin,
      hasQQMusicKey: Boolean(account.qqmusicKey),
      hasEmbyPassword: Boolean(account.embyPassword),
      hasEmbyAccessToken: Boolean(account.embyAccessToken),
    },
    qq: summarizeQQLoginState(accountToQQLoginState(account)),
  }
}

export async function getAccountFavorites(qqUin: string, page = 1, limit = 50): Promise<AccountFavorites | undefined> {
  const account = getAccountByQQ(qqUin)
  if (!account) return undefined

  const normalizedPage = normalizePage(page)
  const normalizedLimit = normalizeLimit(limit)
  const localFavorites = listAccountLocalFavorites(qqUin, normalizedPage, normalizedLimit)
  return getQQFavoriteSongs({ cookie: account.qqCookie, page: normalizedPage, limit: normalizedLimit })
    .then(result => ({
      source: 'qq' as const,
      total: Math.max(result.total, localFavorites.length),
      page: normalizedPage,
      limit: normalizedLimit,
      items: mergeAccountTrackItems(result.list.map(song => ({ ...song })), localFavorites),
    }))
    .catch((error: unknown) => ({
      source: 'local' as const,
      total: localFavorites.length,
      page: normalizedPage,
      limit: normalizedLimit,
      items: localFavorites,
      error: error instanceof Error ? error.message : String(error),
    }))
}

export function getAccountRecentPlays(qqUin: string, page = 1, limit = 50): AccountTrackPage | undefined {
  if (!getAccountByQQ(qqUin)) return undefined
  const normalizedPage = normalizePage(page)
  const normalizedLimit = normalizeLimit(limit)
  return {
    page: normalizedPage,
    limit: normalizedLimit,
    total: countAccountRecentPlays(qqUin),
    items: listAccountRecentPlays(qqUin, normalizedPage, normalizedLimit),
  }
}

function mergeAccountTrackItems(primary: AccountTrackItem[], secondary: AccountTrackItem[]): AccountTrackItem[] {
  const seen = new Set(primary.map(item => `${item.source}:${item.songmid}`))
  const merged = [...primary]
  for (const item of secondary) {
    const key = `${item.source}:${item.songmid}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(item)
  }
  return merged
}

export function isAdminQQ(qqUin: string | undefined): boolean {
  if (!qqUin) return false
  return appConfig.adminQQUins.includes(qqUin.replace(/^o/i, ''))
}

export function markAccountActive(qqUin: string): void {
  db.prepare(`
    UPDATE accounts
    SET last_active_at = CURRENT_TIMESTAMP
    WHERE qq_uin = ?
  `).run(qqUin)
}

export function markAccountLogin(qqUin: string, loginIp?: string): void {
  db.prepare(`
    UPDATE accounts
    SET
      last_login_at = CURRENT_TIMESTAMP,
      last_login_ip = COALESCE(?, last_login_ip),
      last_active_at = CURRENT_TIMESTAMP
    WHERE qq_uin = ?
  `).run(loginIp ?? null, qqUin)
}

export async function refreshAccountQQProfile(qqUin: string): Promise<AccountRecord | undefined> {
  const account = getAccountByQQ(qqUin)
  if (!account) return undefined

  const profile = await getQQUserProfile({ uin: qqUin, cookie: account.qqCookie }).catch(() => undefined)
  if (profile?.nickname) updateAccountQQNickname(qqUin, profile.nickname)
  return getAccountByQQ(qqUin)
}

export function updateAccountQQNickname(qqUin: string, nickname: string): AccountRecord | undefined {
  const normalized = nickname.trim()
  if (!normalized) return getAccountByQQ(qqUin)

  db.prepare(`
    UPDATE accounts
    SET
      qq_nickname = @nickname,
      updated_at = CURRENT_TIMESTAMP
    WHERE qq_uin = @qqUin
  `).run({
    qqUin,
    nickname: normalized,
  })

  return getAccountByQQ(qqUin)
}

export function updateAccountEmbyAuth(input: {
  qqUin: string
  embyUserId?: string
  embyAccessToken?: string
}): void {
  db.prepare(`
    UPDATE accounts
    SET
      emby_user_id = COALESCE(@embyUserId, emby_user_id),
      emby_access_token = COALESCE(@embyAccessToken, emby_access_token),
      updated_at = CURRENT_TIMESTAMP
    WHERE qq_uin = @qqUin
  `).run({
    qqUin: input.qqUin,
    embyUserId: input.embyUserId ?? null,
    embyAccessToken: input.embyAccessToken ?? null,
  })
}

export function updateAccountEmbyPassword(qqUin: string, password: string): AccountRecord | undefined {
  const normalized = password.trim()
  if (!normalized) return getAccountByQQ(qqUin)

  db.prepare(`
    UPDATE accounts
    SET
      emby_password = @password,
      updated_at = CURRENT_TIMESTAMP
    WHERE qq_uin = @qqUin
  `).run({
    qqUin,
    password: normalized,
  })

  return getAccountByQQ(qqUin)
}

export function accountToQQLoginState(account: AccountRecord): QQLoginState {
  return {
    cookie: account.qqCookie,
    uin: account.qqUin,
    encryptedUin: account.encryptedUin,
    qqmusicKey: account.qqmusicKey,
    source: 'stored',
  }
}

export function summarizeAccount(account: AccountRecord) {
  return {
    ...summarizeQQLoginState(accountToQQLoginState(account)),
    nickname: account.qqNickname,
    isAdmin: isAdminQQ(account.qqUin),
    emby: {
      username: account.embyUsername,
      hasPassword: Boolean(account.embyPassword),
      userId: account.embyUserId,
      hasAccessToken: Boolean(account.embyAccessToken),
    },
  }
}

function rowToAccount(row: AccountRow): AccountRecord {
  return {
    qqUin: row.qq_uin,
    qqNickname: row.qq_nickname ?? undefined,
    qqCookie: row.qq_cookie,
    encryptedUin: row.encrypted_uin ?? undefined,
    qqmusicKey: row.qqmusic_key ?? undefined,
    embyUserId: row.emby_user_id ?? undefined,
    embyUsername: row.emby_username,
    embyPassword: row.emby_password,
    embyAccessToken: row.emby_access_token ?? undefined,
    lastLoginAt: row.last_login_at ?? undefined,
    lastLoginIp: row.last_login_ip ?? undefined,
    lastActiveAt: row.last_active_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function accountStatsByQQ(): Map<string, { playCount: number; favoriteCount: number }> {
  const singleAccount = db.prepare('SELECT qq_uin FROM accounts ORDER BY updated_at DESC LIMIT 2').all() as Array<{ qq_uin: string }>
  const fallbackQQ = singleAccount.length === 1 ? singleAccount[0].qq_uin : undefined
  const stats = new Map<string, { playCount: number; favoriteCount: number }>()
  for (const account of singleAccount.length === 1 ? singleAccount : listAccounts().map(item => ({ qq_uin: item.qqUin }))) {
    const playCount = countAccountRecentPlays(account.qq_uin)
    const favoriteCount = countAccountFavorites(account.qq_uin)
    stats.set(account.qq_uin, { playCount, favoriteCount })
  }
  return stats
}

function countAccountFavorites(qqUin: string): number {
  const fallbackToGlobal = shouldUseGlobalHistoryFallback(qqUin)
  const row = db.prepare(`
    SELECT COUNT(DISTINCT track_id) AS count
    FROM (
      SELECT track_id
      FROM account_favorites
      WHERE qq_uin = @qqUin
        AND desired_state = 'favorite'
      UNION ALL
      SELECT fs.track_id
      FROM favorite_sync fs
      WHERE @fallbackToGlobal = 1
        AND fs.qq_uin IS NULL
        AND fs.desired_state = 'favorite'
        AND NOT EXISTS (
          SELECT 1 FROM account_favorites af
          WHERE af.qq_uin = @qqUin AND af.track_id = fs.track_id
        )
    )
  `).get({ qqUin, fallbackToGlobal: fallbackToGlobal ? 1 : 0 }) as { count: number }
  return row.count
}

function listAccountLocalFavorites(qqUin: string, page: number, limit: number): AccountTrackItem[] {
  const fallbackToGlobal = shouldUseGlobalHistoryFallback(qqUin)
  const offset = (page - 1) * limit
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
      t.raw_json,
      af.updated_at AS favorite_updated_at,
      af.sync_state
    FROM (
      SELECT track_id, updated_at, sync_state
      FROM account_favorites
      WHERE qq_uin = @qqUin
        AND desired_state = 'favorite'
      UNION ALL
      SELECT fs.track_id, fs.updated_at, fs.sync_state
      FROM favorite_sync fs
      WHERE @fallbackToGlobal = 1
        AND fs.qq_uin IS NULL
        AND fs.desired_state = 'favorite'
        AND NOT EXISTS (
          SELECT 1 FROM account_favorites af
          WHERE af.qq_uin = @qqUin AND af.track_id = fs.track_id
        )
    ) af
    INNER JOIN tracks t ON t.id = af.track_id
    ORDER BY af.updated_at DESC
    LIMIT @limit
    OFFSET @offset
  `).all({ qqUin, fallbackToGlobal: fallbackToGlobal ? 1 : 0, limit, offset }) as Array<{
    source: MusicInfo['source']
    songmid: string
    name: string
    singer: string
    album_name: string | null
    album_id: string | null
    interval: string | null
    image_url: string | null
    raw_json: string | null
    favorite_updated_at: string
    sync_state: string
  }>

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
    favoriteUpdatedAt: row.favorite_updated_at,
    syncState: row.sync_state,
  }))
}

function listAccountRecentPlays(qqUin: string, page: number, limit: number): AccountTrackItem[] {
  const fallbackToGlobal = shouldUseGlobalHistoryFallback(qqUin)
  const offset = (page - 1) * limit
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
      t.raw_json,
      pe.quality,
      pe.played_at
    FROM play_events pe
    INNER JOIN tracks t ON t.id = pe.track_id
    WHERE pe.qq_uin = @qqUin
      OR (@fallbackToGlobal = 1 AND pe.qq_uin IS NULL)
    ORDER BY pe.played_at DESC, pe.id DESC
    LIMIT @limit
    OFFSET @offset
  `).all({ qqUin, fallbackToGlobal: fallbackToGlobal ? 1 : 0, limit, offset }) as Array<{
    source: MusicInfo['source']
    songmid: string
    name: string
    singer: string
    album_name: string | null
    album_id: string | null
    interval: string | null
    image_url: string | null
    raw_json: string | null
    quality: MusicQuality
    played_at: string
  }>

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
    playedAt: row.played_at,
  }))
}

function countAccountRecentPlays(qqUin: string): number {
  const fallbackToGlobal = shouldUseGlobalHistoryFallback(qqUin)
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM play_events pe
    WHERE pe.qq_uin = @qqUin
      OR (@fallbackToGlobal = 1 AND pe.qq_uin IS NULL)
  `).get({ qqUin, fallbackToGlobal: fallbackToGlobal ? 1 : 0 }) as { count: number }
  return row.count
}

function normalizePage(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 1
}

function normalizeLimit(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.trunc(value), 100) : 50
}

function shouldUseGlobalHistoryFallback(qqUin: string): boolean {
  const rows = db.prepare('SELECT qq_uin FROM accounts ORDER BY updated_at DESC LIMIT 2').all() as Array<{ qq_uin: string }>
  return rows.length === 1 && rows[0].qq_uin === qqUin
}

function parseRawJson(value: string | null): unknown {
  if (!value) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function generateAccountPassword(): string {
  return crypto.randomBytes(18).toString('base64url')
}

export function embyUsernameForQQ(qqUin: string): string {
  return `QQ${qqUin}`
}
