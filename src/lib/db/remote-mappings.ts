import { db } from './index'

export interface RemoteMappingRecord {
  id: number
  localType: string
  localKey: string
  remote: string
  remoteId: string
  rawJson?: string
  createdAt: string
  updatedAt: string
}

export function upsertRemoteMapping(input: {
  localType: string
  localKey: string
  remote: string
  remoteId: string
  raw?: unknown
}): RemoteMappingRecord {
  db.prepare(`
    INSERT INTO remote_mappings (local_type, local_key, remote, remote_id, raw_json, updated_at)
    VALUES (@localType, @localKey, @remote, @remoteId, @rawJson, CURRENT_TIMESTAMP)
    ON CONFLICT(local_type, local_key, remote) DO UPDATE SET
      remote_id = excluded.remote_id,
      raw_json = excluded.raw_json,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    localType: input.localType,
    localKey: input.localKey,
    remote: input.remote,
    remoteId: input.remoteId,
    rawJson: input.raw == null ? null : JSON.stringify(input.raw),
  })

  const row = db.prepare(`
    SELECT
      id,
      local_type AS localType,
      local_key AS localKey,
      remote,
      remote_id AS remoteId,
      raw_json AS rawJson,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM remote_mappings
    WHERE local_type = ? AND local_key = ? AND remote = ?
  `).get(input.localType, input.localKey, input.remote) as RemoteMappingRecord | undefined
  if (!row) throw new Error('Failed to load remote mapping')
  return row
}

export function getRemoteMapping(input: {
  localType: string
  localKey: string
  remote: string
}): RemoteMappingRecord | undefined {
  return db.prepare(`
    SELECT
      id,
      local_type AS localType,
      local_key AS localKey,
      remote,
      remote_id AS remoteId,
      raw_json AS rawJson,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM remote_mappings
    WHERE local_type = @localType AND local_key = @localKey AND remote = @remote
  `).get(input) as RemoteMappingRecord | undefined
}

export function getRemoteMappingByRemote(input: {
  remote: string
  remoteId: string
}): RemoteMappingRecord | undefined {
  return db.prepare(`
    SELECT
      id,
      local_type AS localType,
      local_key AS localKey,
      remote,
      remote_id AS remoteId,
      raw_json AS rawJson,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM remote_mappings
    WHERE remote = @remote AND remote_id = @remoteId
    LIMIT 1
  `).get(input) as RemoteMappingRecord | undefined
}

export function deleteRemoteMapping(input: {
  localType: string
  localKey: string
  remote: string
  remoteId?: string
}): void {
  db.prepare(`
    DELETE FROM remote_mappings
    WHERE local_type = @localType AND local_key = @localKey AND remote = @remote
      AND (@remoteId IS NULL OR remote_id = @remoteId)
  `).run(input)
}
