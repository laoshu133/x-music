import { db } from '@/lib/db'
import type { MusicInfo } from '@/lib/types'

export interface MusicUrlCandidate {
  source: string
  musicId: string
  confidence?: number
  matchedBy?: 'source-id' | 'cache' | 'lookup'
  raw?: unknown
}

export interface ResolveMusicIdsLookupInput {
  musicInfo: MusicInfo
  sources: string[]
}

export interface ResolveMusicIdsOptions {
  sourceOrder: string[]
  lookup?: (input: ResolveMusicIdsLookupInput) => Promise<MusicUrlCandidate[]>
  now?: Date
}

interface CandidateCacheRecord {
  version: 1
  source: string
  songmid: string
  candidates: MusicUrlCandidate[]
  lookupAttemptedAt?: string
  lookupError?: string
  expiresAt: string
}

const CACHE_PREFIX = 'music-url.candidates.'
const SUCCESS_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MISS_TTL_MS = 24 * 60 * 60 * 1000
const inflightLookups = new Map<string, Promise<MusicUrlCandidate[]>>()

export async function resolveMusicIds(
  musicInfo: MusicInfo,
  options: ResolveMusicIdsOptions,
): Promise<MusicUrlCandidate[]> {
  const now = options.now ?? new Date()
  const baseCandidates = candidateMapFromMusicInfo(musicInfo)
  const cached = readCandidateCache(musicInfo, now)
  if (cached) mergeCandidates(baseCandidates, cached.candidates, 'cache')

  const ordered = orderedCandidates(baseCandidates, options.sourceOrder)
  if (!options.lookup || !shouldLookupMissingCandidates(musicInfo, options.sourceOrder, ordered, cached, now)) {
    return ordered
  }

  const lookupKey = cacheKey(musicInfo)
  let lookup = inflightLookups.get(lookupKey)
  if (!lookup) {
    lookup = options.lookup({ musicInfo, sources: options.sourceOrder })
      .then(candidates => candidates.filter(isUsableCandidate))
      .then(candidates => {
        writeCandidateCache(musicInfo, mergeCandidateLists(ordered, candidates), now, undefined)
        return candidates
      })
      .catch((error: unknown) => {
        writeCandidateCache(musicInfo, ordered, now, error instanceof Error ? error.message : String(error))
        return []
      })
      .finally(() => {
        inflightLookups.delete(lookupKey)
      })
    inflightLookups.set(lookupKey, lookup)
  }

  const lookedUp = await lookup
  mergeCandidates(baseCandidates, lookedUp, 'lookup')
  return orderedCandidates(baseCandidates, options.sourceOrder)
}

function shouldLookupMissingCandidates(
  musicInfo: MusicInfo,
  sourceOrder: string[],
  current: MusicUrlCandidate[],
  cached: CandidateCacheRecord | undefined,
  now: Date,
): boolean {
  if (!hasReliableSearchMetadata(musicInfo)) return false
  const currentSources = new Set(current.map(candidate => candidate.source))
  if (sourceOrder.every(source => currentSources.has(source))) return false
  if (!cached) return true
  return Date.parse(cached.expiresAt) <= now.getTime()
}

function hasReliableSearchMetadata(musicInfo: MusicInfo): boolean {
  return Boolean(musicInfo.name.trim() && musicInfo.singer.trim() && musicInfo.interval?.trim())
}

function candidateMapFromMusicInfo(musicInfo: MusicInfo): Map<string, MusicUrlCandidate> {
  const map = new Map<string, MusicUrlCandidate>()
  collectCandidate(map, musicInfo.source, musicInfo.songmid, 'source-id')
  collectCandidatesFromUnknown(map, musicInfo.raw)
  return map
}

function collectCandidatesFromUnknown(map: Map<string, MusicUrlCandidate>, value: unknown): void {
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  for (const key of ['lxSources', 'alternateSources', 'otherSources', 'sourceIds', 'sources']) {
    collectCandidateContainer(map, record[key])
  }
}

function collectCandidateContainer(map: Map<string, MusicUrlCandidate>, value: unknown): void {
  if (!value) return
  if (Array.isArray(value)) {
    for (const item of value) collectCandidateItem(map, item)
    return
  }
  if (typeof value !== 'object') return
  const record = value as Record<string, unknown>
  if ('source' in record || 'platform' in record || 'musicId' in record || 'songmid' in record || 'id' in record) {
    collectCandidateItem(map, record)
    return
  }
  for (const [source, id] of Object.entries(record)) {
    if (typeof id === 'string') {
      collectCandidate(map, source, id, 'source-id')
    } else {
      collectCandidateItem(map, { source, ...(id && typeof id === 'object' ? id as Record<string, unknown> : {}) })
    }
  }
}

function collectCandidateItem(map: Map<string, MusicUrlCandidate>, value: unknown): void {
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  const source = nonEmptyString(record.source) ?? nonEmptyString(record.platform)
  const musicId = nonEmptyString(record.musicId)
    ?? nonEmptyString(record.songmid)
    ?? nonEmptyString(record.songId)
    ?? nonEmptyString(record.id)
    ?? nonEmptyString(record.mid)
  if (source && musicId) {
    collectCandidate(map, source, musicId, 'source-id', finiteNumber(record.confidence), value)
  }
}

function collectCandidate(
  map: Map<string, MusicUrlCandidate>,
  source: string | undefined,
  musicId: string | undefined,
  matchedBy: MusicUrlCandidate['matchedBy'],
  confidence?: number,
  raw?: unknown,
): void {
  const normalizedSource = source?.trim()
  const normalizedMusicId = musicId?.trim()
  if (!normalizedSource || !normalizedMusicId || map.has(normalizedSource)) return
  map.set(normalizedSource, {
    source: normalizedSource,
    musicId: normalizedMusicId,
    matchedBy,
    confidence,
    raw,
  })
}

function mergeCandidates(
  map: Map<string, MusicUrlCandidate>,
  candidates: MusicUrlCandidate[],
  matchedBy: MusicUrlCandidate['matchedBy'],
): void {
  for (const candidate of candidates) {
    collectCandidate(map, candidate.source, candidate.musicId, candidate.matchedBy ?? matchedBy, candidate.confidence, candidate.raw)
  }
}

function orderedCandidates(map: Map<string, MusicUrlCandidate>, sourceOrder: string[]): MusicUrlCandidate[] {
  return sourceOrder
    .map(source => map.get(source))
    .filter((candidate): candidate is MusicUrlCandidate => Boolean(candidate))
}

function mergeCandidateLists(primary: MusicUrlCandidate[], secondary: MusicUrlCandidate[]): MusicUrlCandidate[] {
  const map = new Map<string, MusicUrlCandidate>()
  for (const candidate of [...primary, ...secondary]) {
    if (isUsableCandidate(candidate) && !map.has(candidate.source)) map.set(candidate.source, candidate)
  }
  return [...map.values()]
}

function readCandidateCache(musicInfo: MusicInfo, now: Date): CandidateCacheRecord | undefined {
  const row = db.prepare('SELECT value_json AS valueJson FROM app_settings WHERE key = ?').get(cacheKey(musicInfo)) as { valueJson?: string } | undefined
  if (!row?.valueJson) return undefined
  try {
    const parsed = JSON.parse(row.valueJson) as CandidateCacheRecord
    if (parsed.version !== 1 || parsed.source !== musicInfo.source || parsed.songmid !== musicInfo.songmid) return undefined
    if (!Array.isArray(parsed.candidates)) return undefined
    if (Date.parse(parsed.expiresAt) <= now.getTime()) return parsed
    return parsed
  } catch {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(cacheKey(musicInfo))
    return undefined
  }
}

function writeCandidateCache(
  musicInfo: MusicInfo,
  candidates: MusicUrlCandidate[],
  now: Date,
  lookupError?: string,
): void {
  const usableCandidates = candidates.filter(isUsableCandidate)
  const hasLookupCandidate = usableCandidates.some(candidate => candidate.source !== musicInfo.source)
  const ttl = lookupError || !hasLookupCandidate ? MISS_TTL_MS : SUCCESS_TTL_MS
  const record: CandidateCacheRecord = {
    version: 1,
    source: musicInfo.source,
    songmid: musicInfo.songmid,
    candidates: usableCandidates,
    lookupAttemptedAt: now.toISOString(),
    lookupError,
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
  }
  db.prepare(`
    INSERT INTO app_settings (key, value_json, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(cacheKey(musicInfo), JSON.stringify(record))
}

function cacheKey(musicInfo: Pick<MusicInfo, 'source' | 'songmid'>): string {
  return `${CACHE_PREFIX}${musicInfo.source}.${musicInfo.songmid}`
}

function isUsableCandidate(candidate: MusicUrlCandidate): boolean {
  return Boolean(candidate.source?.trim() && candidate.musicId?.trim())
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
