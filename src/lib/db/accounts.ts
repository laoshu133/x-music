import crypto from 'node:crypto'
import { db } from '@/lib/db'
import { buildQQLoginState, summarizeQQLoginState, type QQLoginState } from '@/lib/qq/account'

export interface AccountRecord {
  qqUin: string
  qqCookie: string
  encryptedUin?: string
  qqmusicKey?: string
  embyUserId?: string
  embyUsername: string
  embyPassword: string
  embyAccessToken?: string
  createdAt: string
  updatedAt: string
}

export interface AccountUpsertResult {
  account: AccountRecord
  generatedPassword?: string
}

interface AccountRow {
  qq_uin: string
  qq_cookie: string
  encrypted_uin: string | null
  qqmusic_key: string | null
  emby_user_id: string | null
  emby_username: string
  emby_password: string
  emby_access_token: string | null
  created_at: string
  updated_at: string
}

export function upsertAccountFromQQCookie(cookieText: string): AccountUpsertResult {
  const state = buildQQLoginState(cookieText, 'stored')
  const existing = getAccountByQQ(state.uin)
  const embyUsername = embyUsernameForQQ(state.uin)
  const generatedPassword = existing ? undefined : generateAccountPassword()
  const embyPassword = existing?.embyPassword ?? generatedPassword!

  db.prepare(`
    INSERT INTO accounts (
      qq_uin,
      qq_cookie,
      encrypted_uin,
      qqmusic_key,
      emby_user_id,
      emby_username,
      emby_password,
      emby_access_token,
      updated_at
    )
    VALUES (
      @qqUin,
      @qqCookie,
      @encryptedUin,
      @qqmusicKey,
      @embyUserId,
      @embyUsername,
      @embyPassword,
      @embyAccessToken,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(qq_uin) DO UPDATE SET
      qq_cookie = excluded.qq_cookie,
      encrypted_uin = excluded.encrypted_uin,
      qqmusic_key = excluded.qqmusic_key,
      emby_username = excluded.emby_username,
      emby_password = excluded.emby_password,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    qqUin: state.uin,
    qqCookie: state.cookie,
    encryptedUin: state.encryptedUin ?? null,
    qqmusicKey: state.qqmusicKey ?? null,
    embyUserId: existing?.embyUserId ?? null,
    embyUsername,
    embyPassword,
    embyAccessToken: existing?.embyAccessToken ?? null,
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
  const row = db.prepare('SELECT * FROM accounts WHERE emby_username = ?').get(username) as AccountRow | undefined
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
    qqCookie: row.qq_cookie,
    encryptedUin: row.encrypted_uin ?? undefined,
    qqmusicKey: row.qqmusic_key ?? undefined,
    embyUserId: row.emby_user_id ?? undefined,
    embyUsername: row.emby_username,
    embyPassword: row.emby_password,
    embyAccessToken: row.emby_access_token ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function generateAccountPassword(): string {
  return crypto.randomBytes(18).toString('base64url')
}

export function embyUsernameForQQ(qqUin: string): string {
  return `QQ${qqUin}`
}
