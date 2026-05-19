import { appConfig } from '@/lib/config'
import { isMusicQuality, preferredQualities } from '@/lib/quality'
import type { MusicInfo, MusicQuality, ResolvedMusicUrl } from '@/lib/types'

interface MusicUrlResponse {
  url?: unknown
  data?: unknown
  quality?: unknown
  type?: unknown
  code?: unknown
  message?: unknown
  msg?: unknown
  error?: unknown
}

interface LxApiConfig {
  apiUrl: string
  apiKey: string
}

const responseUrlKeys = ['url', 'musicUrl', 'location', 'playUrl'] as const
const lxScriptConfigTtlMs = 10 * 60 * 1000

let lxScriptConfigCache: { source: string; config: LxApiConfig; expiresAt: number } | undefined

export class MusicUrlResolveError extends Error {
  constructor(
    message: string,
    readonly attempts: Array<{ quality: MusicQuality; error: string }>,
  ) {
    super(message)
    this.name = 'MusicUrlResolveError'
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
  if (!appConfig.lxMusicUrlScript) {
    throw new Error('LX_MUSIC_URL_SCRIPT is not configured')
  }

  const url = await resolveThroughLxApi(appConfig.lxMusicUrlScript, musicInfo, quality)

  return {
    url,
    quality,
    source: musicInfo.source,
    songmid: musicInfo.songmid,
  }
}

const resolveLxApiConfig = async (scriptUrl: string): Promise<LxApiConfig> => {
  if (
    lxScriptConfigCache?.source === scriptUrl &&
    lxScriptConfigCache.expiresAt > Date.now()
  ) {
    return lxScriptConfigCache.config
  }

  const response = await fetch(scriptUrl, {
    method: 'GET',
    headers: {
      accept: 'application/javascript, text/plain, */*',
      'user-agent': 'miXmusic/1.0',
    },
    cache: 'no-store',
  })

  const body = await response.text()
  if (!response.ok) {
    throw new Error(`LX music URL script returned ${response.status}: ${body.slice(0, 160)}`)
  }

  const config = parseLxScriptConfig(body)
  if (!config) {
    throw new Error('LX music URL script does not expose API_URL and API_KEY')
  }

  lxScriptConfigCache = {
    source: scriptUrl,
    config,
    expiresAt: Date.now() + lxScriptConfigTtlMs,
  }
  return config
}

const resolveThroughLxApi = async (
  scriptUrl: string,
  musicInfo: MusicInfo,
  quality: MusicQuality,
): Promise<string> => {
  try {
    const config = await resolveLxApiConfig(scriptUrl)
    return await requestMusicUrlFromApi(config, musicInfo, quality)
  } catch (error) {
    if (error instanceof Error && error.message.includes('does not expose API_URL')) {
      return requestLegacyScriptEndpoint(scriptUrl, musicInfo, quality)
    }
    throw error
  }
}

export const getLxMusicApiConfig = resolveLxApiConfig

const parseLxScriptConfig = (script: string): LxApiConfig | undefined => {
  const apiUrl = matchJsStringConstant(script, 'API_URL')
  const apiKey = matchJsStringConstant(script, 'API_KEY') ?? new URL(appConfig.lxMusicUrlScript ?? 'http://invalid').searchParams.get('key') ?? undefined
  if (!apiUrl || apiKey === undefined) return undefined
  return {
    apiUrl: apiUrl.replace(/\/+$/, ''),
    apiKey,
  }
}

const matchJsStringConstant = (script: string, name: string): string | undefined => {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = script.match(new RegExp(`(?:const|let|var)\\s+${escapedName}\\s*=\\s*(['"\`])([^'"\`]+)\\1`))
  return match?.[2]
}

const requestMusicUrlFromApi = async (
  config: LxApiConfig,
  musicInfo: MusicInfo,
  quality: MusicQuality,
): Promise<string> => {
  const requestUrl = `${config.apiUrl}/music/url`
  const response = await fetch(requestUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'user-agent': 'miXmusic/1.0',
      ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
    },
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

  const url = extractMusicUrl(body)
  if (!url) {
    throw new Error(`music-url API did not return a URL: ${body.slice(0, 160)}`)
  }

  return url
}

const requestLegacyScriptEndpoint = async (
  scriptUrl: string,
  musicInfo: MusicInfo,
  quality: MusicQuality,
): Promise<string> => {
  const requestUrl = buildMusicUrlRequest(scriptUrl, musicInfo, quality)
  const response = await fetch(requestUrl, {
    method: 'GET',
    headers: {
      accept: 'application/json, text/plain, */*',
      'user-agent': 'miXmusic/1.0',
    },
    cache: 'no-store',
  })

  const body = await response.text()
  if (!response.ok) {
    throw new Error(`music-url source returned ${response.status}: ${body.slice(0, 160)}`)
  }

  const url = extractMusicUrl(body)
  if (!url) {
    throw new Error(`music-url source did not return a URL: ${body.slice(0, 160)}`)
  }

  return url
}

const buildMusicUrlRequest = (scriptUrl: string, musicInfo: MusicInfo, quality: MusicQuality): string => {
  const url = new URL(scriptUrl)
  const serializedMusicInfo = JSON.stringify(musicInfo)

  // Keep this as broad request-shape compatibility rather than an LX event sandbox.
  url.searchParams.set('source', musicInfo.source)
  url.searchParams.set('action', 'musicUrl')
  url.searchParams.set('type', quality)
  url.searchParams.set('quality', quality)
  url.searchParams.set('songmid', musicInfo.songmid)
  url.searchParams.set('name', musicInfo.name)
  url.searchParams.set('singer', musicInfo.singer)
  url.searchParams.set('musicInfo', serializedMusicInfo)
  url.searchParams.set('info', serializedMusicInfo)

  return url.toString()
}

const extractMusicUrl = (body: string): string | undefined => {
  const trimmed = body.trim()
  if (isProbablyHttpUrl(trimmed)) return trimmed

  const parsed = parseJson(trimmed)
  if (!parsed) return undefined

  return extractUrlFromUnknown(parsed)
}

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

const extractUrlFromUnknown = (value: unknown): string | undefined => {
  if (typeof value === 'string') return isProbablyHttpUrl(value) ? value : undefined
  if (!value || typeof value !== 'object') return undefined

  const response = value as MusicUrlResponse & Record<string, unknown>

  for (const key of responseUrlKeys) {
    const candidate = response[key]
    if (typeof candidate === 'string' && isProbablyHttpUrl(candidate)) return candidate
  }

  const dataResult = extractUrlFromUnknown(response.data)
  if (dataResult) return dataResult

  for (const candidate of Object.values(response)) {
    if (typeof candidate === 'string' && isProbablyHttpUrl(candidate)) return candidate
  }

  return undefined
}

const isProbablyHttpUrl = (value: string): boolean => {
  return value.startsWith('http://') || value.startsWith('https://')
}

export const parseRequestedQuality = (value: string | null | undefined): MusicQuality | undefined => {
  if (!value) return undefined
  return isMusicQuality(value) ? value : undefined
}
