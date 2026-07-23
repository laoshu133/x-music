import { db } from './index'
import { normalizeDbDateTime } from './time'
import { encryptSecret } from '@/lib/security'

export interface RemoteMappingRecord {
  id: number
  userId: string
  localType: string
  localKey: string
  remote: string
  remoteId: string
  rawJson?: string
  createdAt: string
  updatedAt: string
}

type MappingInput = { userId?: string; localType: string; localKey: string; remote: string }

export function upsertRemoteMapping(input: MappingInput & { remoteId: string; raw?: unknown }): RemoteMappingRecord {
  const userId = resolveUserId(input.userId)
  if (!userId) throw new Error('User is required for remote mapping')
  ensureTestUser(userId)
  const params = { ...input, userId, rawJson: input.raw == null ? null : JSON.stringify(input.raw) }
  db.prepare(`
    INSERT INTO remote_mappings (user_id, local_type, local_key, remote, remote_id, raw_json, updated_at)
    VALUES (@userId, @localType, @localKey, @remote, @remoteId, @rawJson, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, local_type, local_key, remote) DO UPDATE SET
      remote_id = excluded.remote_id, raw_json = excluded.raw_json, updated_at = CURRENT_TIMESTAMP
  `).run(params)
  return getRemoteMapping(input)!
}

export function getRemoteMapping(input: MappingInput): RemoteMappingRecord | undefined {
  const userId = resolveUserId(input.userId)
  if (!userId) return undefined
  return readMapping(`user_id = @userId AND local_type = @localType AND local_key = @localKey AND remote = @remote`, { ...input, userId })
}

export function getRemoteMappingByRemote(input: { userId?: string; remote: string; remoteId: string }): RemoteMappingRecord | undefined {
  const userId = resolveUserId(input.userId)
  if (!userId) return undefined
  return readMapping('user_id = @userId AND remote = @remote AND remote_id = @remoteId', { ...input, userId })
}

export function deleteRemoteMapping(input: MappingInput & { remoteId?: string }): void {
  const userId = resolveUserId(input.userId)
  if (!userId) return
  db.prepare(`
    DELETE FROM remote_mappings
    WHERE user_id = @userId AND local_type = @localType AND local_key = @localKey AND remote = @remote
      AND (@remoteId IS NULL OR remote_id = @remoteId)
  `).run({ ...input, userId, remoteId: input.remoteId ?? null })
}

function readMapping(where: string, params: object): RemoteMappingRecord | undefined {
  const row = db.prepare(`
    SELECT id, user_id AS userId, local_type AS localType, local_key AS localKey, remote,
           remote_id AS remoteId, raw_json AS rawJson, created_at AS createdAt, updated_at AS updatedAt
    FROM remote_mappings WHERE ${where} LIMIT 1
  `).get(params) as RemoteMappingRecord | undefined
  return row ? { ...row, createdAt: normalizeDbDateTime(row.createdAt), updatedAt: normalizeDbDateTime(row.updatedAt) } : undefined
}

function resolveUserId(userId?: string): string | undefined {
  if (userId || process.env.NODE_ENV !== 'test') return userId
  return (db.prepare("SELECT value FROM app_meta WHERE key = 'test.current_qq_user_id'").get() as { value?: string } | undefined)?.value
}

function ensureTestUser(userId: string): void {
  if (process.env.NODE_ENV !== 'test') return
  if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return
  db.prepare("INSERT INTO users (id, username, password_hash, role, status) VALUES (?, ?, 'test-only', 'user', 'active')").run(userId, `test-${userId}`)
  db.prepare('INSERT INTO user_emby_profiles (user_id, player_password_encrypted) VALUES (?, ?)').run(userId, encryptSecret('test-player-password'))
}
