// Legacy test factory. Production authorization is always bound to an existing user_id.
import { db } from '@/lib/db'
import { accountToQQLoginState, bindQQAuthorization, getAccountByQQ, getAccountByUserId, updateAccountQQCookie } from '@/lib/db/accounts'
import { buildQQLoginState, type QQLoginState } from '@/lib/qq/account'
import { encryptSecret, randomToken } from '@/lib/security'

const testCurrentKey = 'test.current_qq_user_id'

export function saveQQLoginCookie(cookieText: string, options: { loginIp?: string } = {}): ReturnType<typeof legacySummary> {
  assertTestOnly()
  const state = buildQQLoginState(cookieText, 'stored')
  let account = getAccountByQQ(state.uin)
  const isNew = !account
  if (!account) {
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(state.uin)) {
      db.prepare(`INSERT INTO users (id, username, password_hash, role, status, last_login_at, last_login_ip) VALUES (?, ?, 'test-only', 'user', 'active', CURRENT_TIMESTAMP, ?)`).run(state.uin, `QQ${state.uin}`, options.loginIp ?? null)
    }
    if (!db.prepare('SELECT 1 FROM user_emby_profiles WHERE user_id = ?').get(state.uin)) {
      db.prepare(`INSERT INTO user_emby_profiles (user_id, player_password_encrypted) VALUES (?, ?)`).run(state.uin, encryptSecret(randomToken(18)))
    }
    account = bindQQAuthorization(state.uin, cookieText)
  } else {
    account = updateAccountQQCookie(account.userId, cookieText) ?? account
  }
  db.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(testCurrentKey, account.userId)
  return legacySummary(account, isNew ? account.embyPassword : undefined)
}

export function getStoredQQLoginState(): QQLoginState | undefined {
  assertTestOnly()
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(testCurrentKey) as { value: string } | undefined
  const account = row ? getAccountByUserId(row.value) : undefined
  return account ? accountToQQLoginState(account) : undefined
}

export function updateStoredQQLoginCookie(cookieText: string): QQLoginState {
  const stored = getStoredQQLoginState()
  if (!stored) throw new Error('No test QQ authorization')
  const account = getAccountByQQ(stored.uin)!
  return accountToQQLoginState(updateAccountQQCookie(account.userId, cookieText)!)
}

export function clearQQLoginCookie(): void {
  if (process.env.NODE_ENV === 'test') db.prepare('DELETE FROM app_meta WHERE key = ?').run(testCurrentKey)
}

function legacySummary(account: NonNullable<ReturnType<typeof getAccountByQQ>>, generatedPassword?: string) {
  return {
    loggedIn: true,
    source: 'stored' as const,
    uin: account.qqUin,
    hasEncryptedUin: Boolean(account.encryptedUin),
    hasQQMusicKey: Boolean(account.qqmusicKey),
    nickname: account.qqNickname,
    emby: { username: account.embyUsername, hasPassword: true, userId: account.embyUserId, hasAccessToken: Boolean(account.embyAccessToken), generatedPassword },
  }
}

function assertTestOnly(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Legacy QQ session helpers are test-only')
}
