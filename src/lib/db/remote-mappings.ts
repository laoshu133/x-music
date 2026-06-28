import { db } from './index'

export interface RemoteMappingRecord {
  id: number
  qqUin?: string
  localType: string
  localKey: string
  remote: string
  remoteId: string
  rawJson?: string
  createdAt: string
  updatedAt: string
}

export function upsertRemoteMapping(input: {
  qqUin?: string
  localType: string
  localKey: string
  remote: string
  remoteId: string
  raw?: unknown
}): RemoteMappingRecord {
  const params = {
    qqUin: input.qqUin ?? null,
    localType: input.localType,
    localKey: input.localKey,
    remote: input.remote,
    remoteId: input.remoteId,
    rawJson: input.raw == null ? null : JSON.stringify(input.raw),
  }

  const result = db.prepare(`
    UPDATE remote_mappings
    SET remote_id = @remoteId,
        raw_json = @rawJson,
        updated_at = CURRENT_TIMESTAMP
    WHERE COALESCE(qq_uin, '') = COALESCE(@qqUin, '')
      AND local_type = @localType
      AND local_key = @localKey
      AND remote = @remote
  `).run(params)

  if (result.changes === 0) {
    db.prepare(`
      INSERT INTO remote_mappings (qq_uin, local_type, local_key, remote, remote_id, raw_json, updated_at)
      VALUES (@qqUin, @localType, @localKey, @remote, @remoteId, @rawJson, CURRENT_TIMESTAMP)
    `).run(params)
  }

  const row = db.prepare(`
    SELECT
      id,
      qq_uin AS qqUin,
      local_type AS localType,
      local_key AS localKey,
      remote,
      remote_id AS remoteId,
      raw_json AS rawJson,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM remote_mappings
    WHERE COALESCE(qq_uin, '') = COALESCE(@qqUin, '')
      AND local_type = @localType AND local_key = @localKey AND remote = @remote
  `).get(params) as RemoteMappingRecord | undefined
  if (!row) throw new Error('Failed to load remote mapping')
  return row
}

export function getRemoteMapping(input: {
  qqUin?: string
  localType: string
  localKey: string
  remote: string
}): RemoteMappingRecord | undefined {
  return db.prepare(`
    SELECT
      id,
      qq_uin AS qqUin,
      local_type AS localType,
      local_key AS localKey,
      remote,
      remote_id AS remoteId,
      raw_json AS rawJson,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM remote_mappings
    WHERE local_type = @localType AND local_key = @localKey AND remote = @remote
      AND (
        COALESCE(qq_uin, '') = COALESCE(@qqUin, '')
        OR (@qqUin IS NOT NULL AND qq_uin IS NULL)
      )
    ORDER BY CASE WHEN qq_uin IS NULL THEN 1 ELSE 0 END
    LIMIT 1
  `).get({
    ...input,
    qqUin: input.qqUin ?? null,
  }) as RemoteMappingRecord | undefined
}

export function getRemoteMappingByRemote(input: {
  qqUin?: string
  remote: string
  remoteId: string
}): RemoteMappingRecord | undefined {
  return db.prepare(`
    SELECT
      id,
      qq_uin AS qqUin,
      local_type AS localType,
      local_key AS localKey,
      remote,
      remote_id AS remoteId,
      raw_json AS rawJson,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM remote_mappings
    WHERE remote = @remote AND remote_id = @remoteId
      AND (
        COALESCE(qq_uin, '') = COALESCE(@qqUin, '')
        OR (@qqUin IS NOT NULL AND qq_uin IS NULL)
      )
    ORDER BY CASE WHEN qq_uin IS NULL THEN 1 ELSE 0 END
    LIMIT 1
  `).get({
    ...input,
    qqUin: input.qqUin ?? null,
  }) as RemoteMappingRecord | undefined
}

export function deleteRemoteMapping(input: {
  qqUin?: string
  localType: string
  localKey: string
  remote: string
  remoteId?: string
}): void {
  db.prepare(`
    DELETE FROM remote_mappings
    WHERE COALESCE(qq_uin, '') = COALESCE(@qqUin, '')
      AND local_type = @localType AND local_key = @localKey AND remote = @remote
      AND (@remoteId IS NULL OR remote_id = @remoteId)
  `).run({
    ...input,
    qqUin: input.qqUin ?? null,
    remoteId: input.remoteId ?? null,
  })
}
