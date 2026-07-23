import crypto from 'node:crypto'
import { db } from '@/lib/db'
import { getAccountByUserId, type AccountRecord } from '@/lib/db/accounts'
import { encryptSecret, hashToken, randomToken } from '@/lib/security'

export function createLocalAccessToken(account: Pick<AccountRecord, 'userId'>): string {
  if (process.env.NODE_ENV === 'test' && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(account.userId)) {
    db.prepare("INSERT INTO users (id, username, password_hash, role, status) VALUES (?, ?, 'test-only', 'user', 'active')").run(account.userId, `token-${account.userId}`)
    db.prepare('INSERT INTO user_emby_profiles (user_id, player_password_encrypted) VALUES (?, ?)').run(account.userId, encryptSecret('test-player-password'))
  }
  const token = randomToken()
  db.prepare(`
    INSERT INTO player_tokens (id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(crypto.randomUUID(), account.userId, hashToken(token), new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString())
  return token
}

export function findAccountByAccessToken(token: string | undefined): AccountRecord | undefined {
  if (!token) return undefined
  const row = db.prepare(`
    SELECT user_id FROM player_tokens
    WHERE token_hash = ? AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))
  `).get(hashToken(token)) as { user_id: string } | undefined
  if (!row) return undefined
  db.prepare('UPDATE player_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token_hash = ?').run(hashToken(token))
  return getAccountByUserId(row.user_id)
}

export function localEmbyUserId(userId: string): string {
  return crypto.createHash('sha256').update(`x-music:emby-user:${userId}`).digest('hex').slice(0, 32)
}

export function readEmbyAccessToken(request: Request): string | undefined {
  const url = new URL(request.url)
  return request.headers.get('X-Emby-Token')
    ?? request.headers.get('X-MediaBrowser-Token')
    ?? tokenFromAuthorizationHeader(request.headers.get('X-Emby-Authorization'))
    ?? tokenFromAuthorizationHeader(request.headers.get('Authorization'))
    ?? url.searchParams.get('api_key')
    ?? url.searchParams.get('ApiKey')
    ?? url.searchParams.get('X-Emby-Token')
    ?? url.searchParams.get('X-MediaBrowser-Token')
    ?? url.searchParams.get('Token')
    ?? url.searchParams.get('token')
    ?? undefined
}

function tokenFromAuthorizationHeader(value: string | null): string | undefined {
  if (!value) return undefined
  return value.match(/\bToken="([^"]+)"/i)?.[1] ?? value.match(/\bToken=([^,\s]+)/i)?.[1]
}
