import fs from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { appConfig } from '@/lib/config'
import { db } from '@/lib/db'

export interface CleanupTrackCacheOptions {
  now?: Date
  stagingTtlHours?: number
  inboxTtlDays?: number
  failedTtlDays?: number
  maxBytes?: number
}

export interface CleanupTrackCacheResult {
  deleted: number
  bytes: number
  byReason: Record<string, { count: number; bytes: number }>
}

interface TrackFileCleanupRow {
  id: number
  rawPath?: string | null
  finalPath?: string | null
  lyricsPath?: string | null
  coverPath?: string | null
  status: string
  updatedAt: string
}

interface FileCandidate {
  filePath: string
  size: number
  mtimeMs: number
  reason: string
  trackFileId?: number
  columns?: string[]
  markMissing?: boolean
}

export async function cleanupTrackCache(options: CleanupTrackCacheOptions = {}): Promise<CleanupTrackCacheResult> {
  const now = options.now ?? new Date()
  const maxBytes = options.maxBytes ?? appConfig.trackCacheMaxBytes
  const candidates = new Map<string, FileCandidate>()

  for (const candidate of await staleFilesInDirectory(appConfig.stagingDir, cutoffMs(now, hoursToMs(options.stagingTtlHours ?? appConfig.trackCacheStagingTtlHours)), 'stale_staging')) {
    candidates.set(candidate.filePath, candidate)
  }
  for (const candidate of await staleFilesInDirectory(appConfig.inboxDir, cutoffMs(now, daysToMs(options.inboxTtlDays ?? appConfig.trackCacheInboxTtlDays)), 'stale_inbox')) {
    candidates.set(candidate.filePath, candidate)
  }

  for (const candidate of trackFileCandidates(now, options.failedTtlDays ?? appConfig.trackCacheFailedTtlDays)) {
    candidates.set(candidate.filePath, candidate)
  }
  for (const candidate of await overLimitCandidates(maxBytes)) {
    if (!candidates.has(candidate.filePath)) candidates.set(candidate.filePath, candidate)
  }

  const result: CleanupTrackCacheResult = { deleted: 0, bytes: 0, byReason: {} }
  for (const candidate of candidates.values()) {
    await rm(candidate.filePath, { force: true }).catch(() => undefined)
    updateResult(result, candidate.reason, candidate.size)
    if (candidate.trackFileId && candidate.columns?.length) {
      updateTrackFileAfterDelete(candidate)
    } else {
      clearTrackFilePathReferences(candidate.filePath, candidate.reason)
    }
    await pruneEmptyDirectory(path.dirname(candidate.filePath)).catch(() => undefined)
  }
  return result
}

async function staleFilesInDirectory(directory: string, cutoff: number, reason: string): Promise<FileCandidate[]> {
  const files = await listFiles(directory)
  const result: FileCandidate[] = []
  for (const filePath of files) {
    const fileStat = await stat(filePath).catch(() => undefined)
    if (!fileStat?.isFile() || fileStat.mtimeMs > cutoff) continue
    result.push({ filePath, size: fileStat.size, mtimeMs: fileStat.mtimeMs, reason })
  }
  return result
}

function trackFileCandidates(now: Date, failedTtlDays: number): FileCandidate[] {
  const failedCutoff = new Date(now.getTime() - daysToMs(failedTtlDays)).toISOString()
  const rows = db.prepare(`
    SELECT
      id,
      raw_path AS rawPath,
      final_path AS finalPath,
      lyrics_path AS lyricsPath,
      cover_path AS coverPath,
      status,
      updated_at AS updatedAt
    FROM track_files
    WHERE raw_path IS NOT NULL
       OR final_path IS NOT NULL
       OR lyrics_path IS NOT NULL
       OR cover_path IS NOT NULL
  `).all() as TrackFileCleanupRow[]

  const result: FileCandidate[] = []
  for (const row of rows) {
    const reason = row.status === 'failed' && normalizeDbDate(row.updatedAt) < failedCutoff
      ? 'failed_track_file'
      : undefined
    const fileColumns = [
      ['raw_path', row.rawPath],
      ['final_path', row.finalPath],
      ['lyrics_path', row.lyricsPath],
      ['cover_path', row.coverPath],
    ] as const
    for (const [column, filePath] of fileColumns) {
      if (!filePath || !isManagedTrackCachePath(filePath)) continue
      if (reason) {
        const fileStat = fs.existsSync(filePath) ? fs.statSync(filePath) : undefined
        result.push({
          filePath,
          size: fileStat?.size ?? 0,
          mtimeMs: fileStat?.mtimeMs ?? 0,
          reason,
          trackFileId: row.id,
          columns: [column],
          markMissing: true,
        })
        continue
      }
      if (!fs.existsSync(filePath)) {
        result.push({
          filePath,
          size: 0,
          mtimeMs: 0,
          reason: 'missing_track_file_record',
          trackFileId: row.id,
          columns: [column],
          markMissing: true,
        })
      }
    }
  }
  return result
}

async function overLimitCandidates(maxBytes: number): Promise<FileCandidate[]> {
  if (maxBytes <= 0) return []
  const rows = db.prepare(`
    SELECT
      id,
      raw_path AS rawPath,
      final_path AS finalPath,
      lyrics_path AS lyricsPath,
      cover_path AS coverPath,
      status,
      updated_at AS updatedAt
    FROM track_files
    WHERE status IN ('ready', 'cached_raw', 'failed', 'missing')
  `).all() as TrackFileCleanupRow[]

  const candidates: FileCandidate[] = []
  const seen = new Set<string>()
  let total = 0
  for (const row of rows) {
    const columns = [
      ['raw_path', row.rawPath],
      ['final_path', row.finalPath],
    ] as const
    for (const [column, filePath] of columns) {
      if (!filePath || seen.has(filePath) || !isManagedTrackCachePath(filePath)) continue
      seen.add(filePath)
      const fileStat = await stat(filePath).catch(() => undefined)
      if (!fileStat?.isFile()) continue
      total += fileStat.size
      candidates.push({
        filePath,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        reason: 'track_cache_over_limit',
        trackFileId: row.id,
        columns: [column],
        markMissing: true,
      })
    }
  }
  if (total <= maxBytes) return []

  const deletions: FileCandidate[] = []
  for (const candidate of candidates.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= maxBytes) break
    deletions.push(candidate)
    total -= candidate.size
  }
  return deletions
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const result: string[] = []
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      result.push(...await listFiles(filePath))
    } else if (entry.isFile()) {
      result.push(filePath)
    }
  }
  return result
}

function clearTrackFilePathReferences(filePath: string, reason: string): void {
  for (const column of ['raw_path', 'final_path', 'lyrics_path', 'cover_path']) {
    db.prepare(`
      UPDATE track_files
      SET ${column} = NULL,
          status = 'missing',
          error = @error,
          updated_at = CURRENT_TIMESTAMP
      WHERE ${column} = @filePath
    `).run({
      filePath,
      error: `Local cache file removed by cleanup: ${reason}`,
    })
  }
}

function updateTrackFileAfterDelete(candidate: FileCandidate): void {
  const columns = candidate.columns ?? []
  if (!candidate.trackFileId || !columns.length) return
  db.prepare(`
    UPDATE track_files
    SET ${columns.map(column => `${column} = NULL`).join(', ')},
        status = CASE WHEN @markMissing THEN 'missing' ELSE status END,
        error = CASE WHEN @markMissing THEN @error ELSE error END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({
    id: candidate.trackFileId,
    markMissing: candidate.markMissing ? 1 : 0,
    error: `Local cache file removed by cleanup: ${candidate.reason}`,
  })
}

function updateResult(result: CleanupTrackCacheResult, reason: string, bytes: number): void {
  result.deleted += 1
  result.bytes += bytes
  result.byReason[reason] ??= { count: 0, bytes: 0 }
  result.byReason[reason]!.count += 1
  result.byReason[reason]!.bytes += bytes
}

async function pruneEmptyDirectory(startDir: string): Promise<void> {
  const roots = [path.resolve(appConfig.stagingDir), path.resolve(appConfig.inboxDir), path.resolve(appConfig.musicDir)]
  let current = path.resolve(startDir)
  while (roots.some(root => current !== root && isPathInside(current, root))) {
    await rm(current, { recursive: false, force: true }).catch(() => undefined)
    current = path.dirname(current)
  }
}

function isManagedTrackCachePath(filePath: string): boolean {
  return [appConfig.inboxDir, appConfig.musicDir, appConfig.stagingDir]
    .some(directory => isPathInside(filePath, directory))
}

function isPathInside(candidate: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate))
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function normalizeDbDate(value: string): string {
  return value.includes('T') ? value : value.replace(' ', 'T') + 'Z'
}

function cutoffMs(now: Date, ageMs: number): number {
  return now.getTime() - ageMs
}

function hoursToMs(value: number): number {
  return Math.max(0, value) * 60 * 60 * 1000
}

function daysToMs(value: number): number {
  return Math.max(0, value) * 24 * 60 * 60 * 1000
}
