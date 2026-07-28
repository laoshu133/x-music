import { appConfig } from '@/lib/config'
import { getEffectiveSettings } from '@/lib/db/settings'
import { resolveMusicIds, type MusicUrlCandidate, type ResolveMusicIdsLookupInput } from '@/lib/music-url/candidates'
import { isMusicQuality, preferredQualities } from '@/lib/quality'
import { logServiceEvent, requestLoggingEnabled } from '@/lib/request-log'
import type { MusicInfo, MusicQuality, ResolvedMusicUrl } from '@/lib/types'

interface MusicUrlResponse {
  url?: unknown
  data?: unknown
  ekey?: unknown
  quality?: unknown
  type?: unknown
  code?: unknown
  message?: unknown
  msg?: unknown
  error?: unknown
}

interface LxApiConfig {
  apiUrl: string
  headers: Record<string, string>
}

interface LxMusicUrlResult {
  url?: string
  ekey?: string
}

interface LxResolvedMusicUrlResult {
  url: string
  ekey?: string
}

const responseUrlKeys = ['url', 'musicUrl', 'location', 'playUrl'] as const
const defaultSourceOrder = ['tx', 'kw', 'kg', 'wy', 'mg'] as const
let musicSearchUnsupportedUntil = 0

export class MusicUrlResolveError extends Error {
  constructor(
    message: string,
    readonly attempts: Array<{ quality: MusicQuality; error: string; source?: string; musicId?: string }>,
  ) {
    super(message)
    this.name = 'MusicUrlResolveError'
  }
}

export class MusicUrlConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MusicUrlConfigError'
  }
}

export class MusicUrlUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: string,
    readonly payload?: unknown,
  ) {
    super(message)
    this.name = 'MusicUrlUnavailableError'
  }
}

export const qualityFallbacks = (preferred?: MusicQuality): MusicQuality[] => {
  if (!preferred) return preferredQualities
  const startIndex = preferredQualities.indexOf(preferred)
  if (startIndex < 0) return preferredQualities
  return preferredQualities.slice(startIndex)
}

export const resolveMusicUrlWithFallback = async (
  musicInfo: MusicInfo,
  preferred?: MusicQuality,
): Promise<ResolvedMusicUrl> => {
  const attempts: Array<{ quality: MusicQuality; error: string; source?: string; musicId?: string }> = []

  for (const quality of qualityFallbacks(preferred)) {
    try {
      return await resolveMusicUrl(musicInfo, quality)
    } catch (error) {
      if (error instanceof MusicUrlResolveError) {
        attempts.push(...error.attempts)
      } else {
        attempts.push({
          quality,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  throw new MusicUrlResolveError('Unable to resolve a playable music URL', attempts)
}

export const resolveMusicUrl = async (
  musicInfo: MusicInfo,
  quality: MusicQuality,
): Promise<ResolvedMusicUrl> => {
  const scriptUrl = getConfiguredLxScriptUrl()
  if (!scriptUrl) {
    throw new MusicUrlConfigError('LX_MUSIC_SOURCE_SCRIPT is not configured')
  }

  const config = resolveLxApiConfig(scriptUrl)
  const attempts: Array<{ quality: MusicQuality; error: string; source?: string; musicId?: string }> = []
  const candidates = await musicUrlCandidates(musicInfo)

  for (const candidate of candidates) {
    try {
      const resolved = await requestMusicUrlFromApi(config, candidate, quality)

      return {
        ...resolved,
        quality,
        source: musicInfo.source,
        songmid: musicInfo.songmid,
        upstreamSource: candidate.source,
        upstreamMusicId: candidate.musicId,
      }
    } catch (error) {
      if (error instanceof MusicUrlConfigError) throw error
      const message = error instanceof Error ? error.message : String(error)
      logMusicUrlEvent('music_url_resolve_attempt', musicUrlLogBase(musicInfo, quality, {
        source: candidate.source,
        musicId: candidate.musicId,
        found: false,
        error: message,
        candidateMatchedBy: candidate.matchedBy,
        candidateConfidence: candidate.confidence,
      }), 'error')
      attempts.push({
        quality,
        source: candidate.source,
        musicId: candidate.musicId,
        error: message,
      })
    }
  }

  logMusicUrlEvent('music_url_resolve_failed', musicUrlLogBase(musicInfo, quality, {
    attempts,
  }), 'error')
  throw new MusicUrlResolveError('Unable to resolve a playable music URL', attempts)
}

const resolveLxApiConfig = (scriptUrl: string): LxApiConfig => {
  const url = new URL(scriptUrl)
  const apiKey = url.searchParams.get('key') ?? url.searchParams.get('apiKey') ?? undefined
  if (!apiKey) throw new MusicUrlConfigError('LX_MUSIC_SOURCE_SCRIPT must include key or apiKey for the LX music URL API')

  url.pathname = normalizeApiPath(url.pathname)
  url.search = ''
  return {
    apiUrl: url.toString(),
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'user-agent': 'XMusic/1.0',
      'x-api-key': apiKey,
    },
  }
}

const getConfiguredLxScriptUrl = (): string | undefined => {
  return getEffectiveSettings().lx.sourceScriptUrl
    || process.env.LX_MUSIC_SOURCE_SCRIPT?.trim()
    || appConfig.lxMusicSourceScript
}

const normalizeApiPath = (pathname: string): string => {
  const normalized = pathname.replace(/\/+$/, '')
  if (!normalized || normalized === '/script/lxmusic') return '/music/url'
  return normalized.endsWith('/music/url') ? normalized : `${normalized}/music/url`
}

const requestMusicUrlFromApi = async (
  config: LxApiConfig,
  candidate: MusicUrlCandidate,
  quality: MusicQuality,
): Promise<LxResolvedMusicUrlResult> => {
  const response = await fetch(config.apiUrl, {
    method: 'POST',
    headers: config.headers,
    body: JSON.stringify({
      source: candidate.source,
      musicId: candidate.musicId,
      quality,
    }),
    cache: 'no-store',
  })

  const body = await response.text()
  if (!response.ok) {
    throw new Error(`music-url API returned ${response.status}: ${body.slice(0, 160)}`)
  }

  const result = extractMusicUrlResult(body)
  if (!result.url) {
    const unavailable = musicUrlUnavailableReason(body)
    if (unavailable) {
      throw new MusicUrlUnavailableError(`music-url API unavailable: ${unavailable.reason}`, unavailable.reason, unavailable.payload)
    }
    throw new Error(`music-url API did not return a URL: ${body.slice(0, 160)}`)
  }

  return {
    url: result.url,
    ekey: result.ekey,
  }
}

function musicUrlCandidates(musicInfo: MusicInfo): Promise<MusicUrlCandidate[]> {
  return resolveMusicIds(musicInfo, {
    sourceOrder: configuredSourceOrder(),
    lookup: isMusicIdLookupEnabled() ? resolveMusicIdsFromLxApi : undefined,
  })
}

function configuredSourceOrder(): string[] {
  const raw = process.env.LX_MUSIC_SOURCE_ORDER?.trim()
  const configured = raw ? raw.split(/[,;\s]+/).map(source => source.trim()).filter(Boolean) : []
  return dedupeStrings([...configured, ...defaultSourceOrder])
}

function isMusicIdLookupEnabled(): boolean {
  return appConfig.lxMusicIdLookupEnabled
}

async function resolveMusicIdsFromLxApi(input: ResolveMusicIdsLookupInput): Promise<MusicUrlCandidate[]> {
  if (Date.now() < musicSearchUnsupportedUntil) return []
  const scriptUrl = getConfiguredLxScriptUrl()
  if (!scriptUrl) return []
  const config = resolveLxApiConfig(scriptUrl)
  const searchUrl = musicSearchApiUrl(config.apiUrl)
  const response = await fetch(searchUrl, {
    method: 'POST',
    headers: config.headers,
    body: JSON.stringify({
      source: input.musicInfo.source,
      musicId: input.musicInfo.songmid,
      keyword: searchKeyword(input.musicInfo),
      name: input.musicInfo.name,
      singer: input.musicInfo.singer,
      albumName: input.musicInfo.albumName,
      interval: input.musicInfo.interval,
      sources: input.sources,
      limit: 8,
    }),
    cache: 'no-store',
  })
  if (response.status === 404 || response.status === 405) {
    musicSearchUnsupportedUntil = Date.now() + 24 * 60 * 60 * 1000
    return []
  }
  const body = await response.text()
  if (!response.ok) throw new Error(`music-search API returned ${response.status}: ${body.slice(0, 160)}`)
  return extractMusicIdCandidates(body, input.musicInfo)
}

function musicSearchApiUrl(apiUrl: string): string {
  const url = new URL(apiUrl)
  url.pathname = url.pathname.replace(/\/music\/url$/, '/music/search')
  return url.toString()
}

function searchKeyword(musicInfo: MusicInfo): string {
  return [musicInfo.name, musicInfo.singer].filter(Boolean).join(' ').trim()
}

function extractMusicIdCandidates(body: string, musicInfo: MusicInfo): MusicUrlCandidate[] {
  const parsed = JSON.parse(body) as unknown
  const items = candidateItemsFromResponse(parsed)
  return items
    .map(item => normalizeLookupCandidate(item, musicInfo))
    .filter((candidate): candidate is MusicUrlCandidate => Boolean(candidate && candidate.confidence !== undefined && candidate.confidence >= 0.82))
}

function candidateItemsFromResponse(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  for (const key of ['candidates', 'list', 'songs', 'data', 'result']) {
    const child = record[key]
    if (Array.isArray(child)) return child
    if (child && typeof child === 'object') {
      const nested = candidateItemsFromResponse(child)
      if (nested.length) return nested
    }
  }
  return []
}

function normalizeLookupCandidate(value: unknown, musicInfo: MusicInfo): MusicUrlCandidate | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const source = stringValue(record.source) ?? stringValue(record.platform)
  const musicId = stringValue(record.musicId)
    ?? stringValue(record.songmid)
    ?? stringValue(record.songId)
    ?? stringValue(record.id)
    ?? stringValue(record.mid)
  if (!source || !musicId) return undefined
  const confidence = typeof record.confidence === 'number'
    ? record.confidence
    : candidateConfidence({
      target: musicInfo,
      name: stringValue(record.name) ?? stringValue(record.title),
      singer: stringValue(record.singer) ?? stringValue(record.artist) ?? singerList(record.singers),
      albumName: stringValue(record.albumName) ?? stringValue(record.album),
      interval: stringValue(record.interval) ?? stringValue(record.duration),
    })
  return { source, musicId, confidence, matchedBy: 'lookup', raw: value }
}

function candidateConfidence(input: {
  target: MusicInfo
  name?: string
  singer?: string
  albumName?: string
  interval?: string
}): number {
  let score = 0
  let weight = 0
  weight += 0.45
  score += 0.45 * textSimilarity(input.target.name, input.name)
  weight += 0.3
  score += 0.3 * textSimilarity(input.target.singer, input.singer)
  if (input.target.albumName || input.albumName) {
    weight += 0.1
    score += 0.1 * textSimilarity(input.target.albumName ?? '', input.albumName)
  }
  if (input.target.interval || input.interval) {
    weight += 0.15
    score += 0.15 * durationSimilarity(input.target.interval, input.interval)
  }
  return weight > 0 ? score / weight : 0
}

function textSimilarity(left?: string, right?: string): number {
  const normalizedLeft = normalizeText(left)
  const normalizedRight = normalizeText(right)
  if (!normalizedLeft || !normalizedRight) return 0
  if (normalizedLeft === normalizedRight) return 1
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return 0.88
  const leftTokens = tokenSet(normalizedLeft)
  const rightTokens = tokenSet(normalizedRight)
  if (!leftTokens.size || !rightTokens.size) return 0
  let intersection = 0
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1
  return intersection / Math.max(leftTokens.size, rightTokens.size)
}

function durationSimilarity(left?: string, right?: string): number {
  const leftSeconds = durationSeconds(left)
  const rightSeconds = durationSeconds(right)
  if (leftSeconds === undefined || rightSeconds === undefined) return 0
  const diff = Math.abs(leftSeconds - rightSeconds)
  if (diff <= 2) return 1
  if (diff <= 5) return 0.85
  if (diff <= 10) return 0.6
  return 0
}

function normalizeText(value?: string): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]|【[^】]*】/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function tokenSet(value: string): Set<string> {
  const tokens = value.split(/\s+/).filter(Boolean)
  return new Set(tokens.length ? tokens : [...value])
}

function durationSeconds(value?: string): number | undefined {
  if (!value) return undefined
  if (/^\d+$/.test(value)) return Number(value)
  const parts = value.split(':').map(part => Number(part))
  if (parts.some(part => !Number.isFinite(part))) return undefined
  return parts.reduce((total, part) => total * 60 + part, 0)
}

function singerList(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .map(item => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object') return stringValue((item as Record<string, unknown>).name)
      return undefined
    })
    .filter((item): item is string => Boolean(item))
    .join('、')
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function musicUrlLogBase(
  musicInfo: MusicInfo,
  quality: MusicQuality,
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    songSource: musicInfo.source,
    songmid: musicInfo.songmid,
    songName: musicInfo.name,
    singer: musicInfo.singer,
    requestedQuality: quality,
    ...details,
  }
}

function logMusicUrlEvent(
  event: string,
  details: Record<string, unknown>,
  level: 'info' | 'error' = 'info',
): void {
  const dedicatedSetting = process.env.X_MUSIC_MUSIC_URL_LOGS?.trim().toLowerCase()
  if (dedicatedSetting) {
    if (!['1', 'true', 'on', 'yes'].includes(dedicatedSetting)) return
    console[level](JSON.stringify(cleanLogPayload({ event, ...details })))
    return
  }
  if (requestLoggingEnabled()) logServiceEvent(event, details, level)
}

function cleanLogPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      ts: new Date().toISOString(),
      service: 'x-music',
      ...payload,
    }).filter(([, value]) => value !== undefined && value !== ''),
  )
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)]
}

const extractMusicUrlResult = (body: string): LxMusicUrlResult => {
  const trimmed = body.trim()
  if (isProbablyHttpUrl(trimmed)) return { url: trimmed }

  const parsed = parseJson(trimmed)
  if (!parsed) return {}

  return extractMusicUrlFromUnknown(parsed)
}

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

export const isMusicUrlUnavailableError = (error: unknown): error is MusicUrlUnavailableError => {
  if (error instanceof MusicUrlUnavailableError) return true
  return typeof error === 'object'
    && error !== null
    && (error as { name?: unknown }).name === 'MusicUrlUnavailableError'
}

export const isMusicUrlUnavailableMessage = (value: string): boolean => {
  const normalized = value.toLowerCase()
  return value.includes('ERR无版权')
    || value.includes('无版权')
    || value.includes('未获取到URL')
    || value.includes('未获取到 URL')
    || normalized.includes('no copyright')
    || normalized.includes('copyright unavailable')
    || normalized.includes('did not return a url')
}

function musicUrlUnavailableReason(body: string): { reason: string; payload?: unknown } | undefined {
  const parsed = parseJson(body.trim())
  if (!parsed || typeof parsed !== 'object') return undefined
  const record = parsed as Record<string, unknown>
  const message = String(record.message ?? record.msg ?? record.error ?? '')
  if (!isMusicUrlUnavailableMessage(message)) return undefined
  return { reason: message || 'unavailable', payload: parsed }
}

const extractMusicUrlFromUnknown = (value: unknown): LxMusicUrlResult => {
  if (typeof value === 'string') return isProbablyHttpUrl(value) ? { url: value } : {}
  if (!value || typeof value !== 'object') return {}

  const response = value as MusicUrlResponse & Record<string, unknown>
  const ekey = typeof response.ekey === 'string' && response.ekey.length > 0 ? response.ekey : undefined

  for (const key of responseUrlKeys) {
    const candidate = response[key]
    if (typeof candidate === 'string' && isProbablyHttpUrl(candidate)) return { url: candidate, ekey }
  }

  const dataResult = extractMusicUrlFromUnknown(response.data)
  if (dataResult.url) return { url: dataResult.url, ekey: dataResult.ekey ?? ekey }

  for (const candidate of Object.values(response)) {
    if (typeof candidate === 'string' && isProbablyHttpUrl(candidate)) return { url: candidate, ekey }
  }

  return {}
}

const isProbablyHttpUrl = (value: string): boolean => {
  return value.startsWith('http://') || value.startsWith('https://')
}

export const parseRequestedQuality = (value: string | null | undefined): MusicQuality | undefined => {
  if (!value) return undefined
  return isMusicQuality(value) ? value : undefined
}
