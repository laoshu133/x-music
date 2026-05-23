import { appConfig } from '@/lib/config'
import { getEffectiveSettings } from '@/lib/db/settings'
import { isMusicQuality, preferredQualities } from '@/lib/quality'
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

export class MusicUrlResolveError extends Error {
  constructor(
    message: string,
    readonly attempts: Array<{ quality: MusicQuality; error: string }>,
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
  const attempts: Array<{ quality: MusicQuality; error: string }> = []

  for (const quality of qualityFallbacks(preferred)) {
    try {
      return await resolveMusicUrl(musicInfo, quality)
    } catch (error) {
      attempts.push({
        quality,
        error: error instanceof Error ? error.message : String(error),
      })
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

  const resolved = await requestMusicUrlFromApi(resolveLxApiConfig(scriptUrl), musicInfo, quality)

  return {
    ...resolved,
    quality,
    source: musicInfo.source,
    songmid: musicInfo.songmid,
  }
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
  musicInfo: MusicInfo,
  quality: MusicQuality,
): Promise<LxResolvedMusicUrlResult> => {
  const response = await fetch(config.apiUrl, {
    method: 'POST',
    headers: config.headers,
    body: JSON.stringify({
      source: musicInfo.source,
      musicId: musicInfo.songmid,
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
    throw new Error(`music-url API did not return a URL: ${body.slice(0, 160)}`)
  }

  return {
    url: result.url,
    ekey: result.ekey,
  }
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
