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

  const requestUrl = buildMusicUrlRequest(appConfig.lxMusicUrlScript, musicInfo, quality)
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

  return {
    url,
    quality,
    source: musicInfo.source,
    songmid: musicInfo.songmid,
  }
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
