import crypto from 'node:crypto'
import { db } from '@/lib/db'
import { decryptSecret, encryptSecret, hashToken } from '@/lib/security'

export type QQAuthAttemptMethod = 'qr' | 'mobile'

export function createQQAuthAttempt(input: {
  userId: string
  method: QQAuthAttemptMethod
  verifier: string
  payload: unknown
  ttlMs?: number
}): string {
  const id = crypto.randomUUID()
  const version = (db.prepare('SELECT credential_version FROM qq_authorizations WHERE user_id = ?').get(input.userId) as { credential_version?: number } | undefined)?.credential_version ?? 0
  db.prepare('DELETE FROM qq_auth_attempts WHERE user_id = ? AND method = ?').run(input.userId, input.method)
  db.prepare(`
    INSERT INTO qq_auth_attempts (id, user_id, method, payload_encrypted, verifier_hash, base_credential_version, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.userId,
    input.method,
    encryptSecret(JSON.stringify(input.payload)),
    hashToken(input.verifier),
    version,
    new Date(Date.now() + (input.ttlMs ?? 5 * 60 * 1000)).toISOString(),
  )
  return id
}

export function readQQAuthAttempt<T>(input: {
  id?: string
  userId: string
  method: QQAuthAttemptMethod
  verifier?: string
}): T {
  const row = db.prepare(`
    SELECT payload_encrypted, verifier_hash, base_credential_version
    FROM qq_auth_attempts
    WHERE user_id = @userId AND method = @method
      AND (@id IS NULL OR id = @id)
      AND julianday(expires_at) > julianday('now')
  `).get({ id: input.id ?? null, userId: input.userId, method: input.method }) as {
    payload_encrypted: string
    verifier_hash: string
    base_credential_version: number
  } | undefined
  if (!row || (input.verifier && hashToken(input.verifier) !== row.verifier_hash)) throw new Error('QQ_AUTH_ATTEMPT_INVALID')
  const currentVersion = (db.prepare('SELECT credential_version FROM qq_authorizations WHERE user_id = ?').get(input.userId) as { credential_version?: number } | undefined)?.credential_version ?? 0
  if (currentVersion !== row.base_credential_version) throw new Error('QQ_AUTH_ATTEMPT_STALE')
  return JSON.parse(decryptSecret(row.payload_encrypted)) as T
}

export function consumeQQAuthAttempt(userId: string, method: QQAuthAttemptMethod): void {
  db.prepare('DELETE FROM qq_auth_attempts WHERE user_id = ? AND method = ?').run(userId, method)
}
