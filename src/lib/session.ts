import crypto from 'node:crypto'
import { cookies } from 'next/headers'
import { db } from '@/lib/db'
import { getAccountByUserId, markAccountActive, type AccountRecord } from '@/lib/db/accounts'
import { requireActiveQQAccount } from '@/lib/qq/auth-state'
import { hashToken, randomToken } from '@/lib/security'

const sessionCookieName = 'x_music_session'
const legacySessionCookieName = 'x_music_account'
const sessionMaxAgeSeconds = 60 * 60 * 24 * 30

export async function getCurrentAccount(options: { verifyQQ?: boolean } = {}): Promise<AccountRecord | undefined> {
  let store
  try {
    store = await cookies()
  } catch (error) {
    if (process.env.NODE_ENV !== 'test') throw error
    const row = db.prepare("SELECT value FROM app_meta WHERE key = 'test.current_qq_user_id'").get() as { value?: string } | undefined
    const account = row?.value ? getAccountByUserId(row.value) : undefined
    if (!account || options.verifyQQ === false) return account
    return await requireActiveQQAccount(account)
  }
  const token = store.get(sessionCookieName)?.value
  if (!token) return undefined
  const row = db.prepare(`
    SELECT user_id
    FROM user_sessions
    WHERE token_hash = ? AND julianday(expires_at) > julianday('now')
  `).get(hashToken(token)) as { user_id: string } | undefined
  if (!row) return undefined
  db.prepare('UPDATE user_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE token_hash = ?').run(hashToken(token))
  markAccountActive(row.user_id)
  const account = getAccountByUserId(row.user_id)
  if (!account || options.verifyQQ === false) return account
  return await requireActiveQQAccount(account)
}

export async function setCurrentAccount(userId: string): Promise<void> {
  const token = randomToken()
  const expiresAt = new Date(Date.now() + sessionMaxAgeSeconds * 1000).toISOString()
  db.prepare(`
    INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(crypto.randomUUID(), userId, hashToken(token), expiresAt)
  const store = await cookies()
  store.set(sessionCookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: sessionMaxAgeSeconds,
  })
  store.delete(legacySessionCookieName)
}

export async function clearCurrentAccount(): Promise<void> {
  const store = await cookies()
  const token = store.get(sessionCookieName)?.value
  if (token) db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(hashToken(token))
  store.delete(sessionCookieName)
  store.delete(legacySessionCookieName)
}

export async function clearCurrentAccountIfQQAuthExpired(): Promise<void> {
  // QQ authorization and XMusic identity are independent. Expiry never logs the user out.
}
