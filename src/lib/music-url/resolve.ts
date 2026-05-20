import vm from 'node:vm'
import { appConfig } from '@/lib/config'
import { getEffectiveSettings } from '@/lib/db/settings'
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
  method: string
  headers: Record<string, string>
  body?: string
}

const responseUrlKeys = ['url', 'musicUrl', 'location', 'playUrl'] as const
const lxScriptConfigTtlMs = 10 * 60 * 1000
const lxRequestEventName = 'request'

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

  const url = await resolveThroughLxApi(scriptUrl, musicInfo, quality)

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
    throw new MusicUrlConfigError(`LX music URL script returned ${response.status}: ${body.slice(0, 160)}`)
  }

  const config = parseLxScriptConfig(body)
  if (!config) {
    throw new MusicUrlConfigError('LX music source script did not register a music URL request handler or expose API_URL/API_KEY')
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
    if (error instanceof Error && error.message.includes('did not register a music URL request handler')) {
      return requestLegacyScriptEndpoint(scriptUrl, musicInfo, quality)
    }
    throw error
  }
}

export const getLxMusicApiConfig = resolveLxApiConfig

const parseLxScriptConfig = (script: string): LxApiConfig | undefined => {
  const simulatedConfig = simulateLxSourceScriptConfig(script)
  if (simulatedConfig) return simulatedConfig

  const apiUrl = matchJsStringConstant(script, 'API_URL')
  const apiKey = matchJsStringConstant(script, 'API_KEY') ?? new URL(getConfiguredLxScriptUrl() ?? 'http://invalid').searchParams.get('key') ?? undefined
  if (!apiUrl || apiKey === undefined) return undefined
  return {
    apiUrl: normalizeLegacyApiUrl(apiUrl),
    apiKey,
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'user-agent': 'miXmusic/1.0',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    },
    body: JSON.stringify({
      source: '__MIXMUSIC_SOURCE__',
      musicId: '__MIXMUSIC_MUSIC_ID__',
      quality: '__MIXMUSIC_QUALITY__',
    }),
  }
}

const getConfiguredLxScriptUrl = (): string | undefined => {
  return getEffectiveSettings().lx.sourceScriptUrl
    || process.env.LX_MUSIC_SOURCE_SCRIPT?.trim()
    || appConfig.lxMusicSourceScript
}

const matchJsStringConstant = (script: string, name: string): string | undefined => {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = script.match(new RegExp(`(?:const|let|var)\\s+${escapedName}\\s*=\\s*(['"\`])([^'"\`]+)\\1`))
  return match?.[2]
}

const normalizeLegacyApiUrl = (apiUrl: string): string => {
  const normalized = apiUrl.replace(/\/+$/, '')
  return normalized.endsWith('/music/url') ? normalized : `${normalized}/music/url`
}

const simulateLxSourceScriptConfig = (script: string): LxApiConfig | undefined => {
  const source = getLxRequestHandler(script)
  if (!source) return undefined

  const captured = captureHandlerRequest(source)
  if (!captured?.url) return undefined

  return {
    apiUrl: captured.url,
    apiKey: extractApiKeyFromCapturedRequest(captured),
    method: captured.method,
    headers: captured.headers,
    body: captured.body,
  }
}

interface LxRequestSource {
  handler: unknown
  state: {
    captured?: unknown
  }
}

const getLxRequestHandler = (script: string): LxRequestSource | undefined => {
  const sandbox = {
    __handlers: [] as Array<{ eventName: string; handler: unknown }>,
    __state: {} as LxRequestSource['state'],
  }
  const context = vm.createContext(sandbox, {
    codeGeneration: {
      strings: false,
      wasm: false,
    },
  })

  try {
    vm.runInContext(createLxSandboxBootstrap(), context, { timeout: 250 })
    vm.runInContext(script, context, { timeout: 250 })
  } catch {
    return undefined
  }

  const handler = sandbox.__handlers.find(({ eventName, handler }) => (
    eventName === lxRequestEventName && typeof handler === 'function'
  ))?.handler
  return handler ? { handler, state: sandbox.__state } : undefined
}

const createLxSandboxBootstrap = (): string => `
  Object.defineProperty(globalThis, 'constructor', {
    value: undefined,
    writable: false,
    configurable: false
  })
  const unavailable = (name) => function () {
    throw new Error(name + ' is not available in the LX source sandbox')
  }
  globalThis.lx = {
    EVENT_NAMES: {
      request: '${lxRequestEventName}',
      updateAlert: 'updateAlert',
      inited: 'inited'
    },
    on(eventName, handler) {
      if (typeof eventName === 'string') globalThis.__handlers.push({ eventName, handler })
    },
    request(input, init, callback) {
      globalThis.__state.captured = { input, init }
      if (typeof init === 'function') init(new Error('Captured LX source request'))
      if (typeof callback === 'function') callback(new Error('Captured LX source request'))
      return function cancelRequest() {}
    },
    send() {},
    env: {},
    currentScriptInfo: {},
    utils: {}
  }
  globalThis.console = {
    debug() {},
    error() {},
    info() {},
    log() {},
    warn() {}
  }
  globalThis.setTimeout = unavailable('setTimeout')
  globalThis.setInterval = unavailable('setInterval')
  globalThis.clearTimeout = function () {}
  globalThis.clearInterval = function () {}
  globalThis.fetch = unavailable('fetch')
  globalThis.XMLHttpRequest = unavailable('XMLHttpRequest')
  globalThis.WebSocket = unavailable('WebSocket')
`

interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

const captureHandlerRequest = (source: LxRequestSource): CapturedRequest | undefined => {
  if (typeof source.handler !== 'function') return undefined

  try {
    Reflect.apply(source.handler, undefined, [
      {
        source: 'tx',
        action: 'musicUrl',
        info: {
          type: '__MIXMUSIC_QUALITY__',
          quality: '__MIXMUSIC_QUALITY__',
          musicInfo: {
            source: 'tx',
            songmid: '__MIXMUSIC_MUSIC_ID__',
            musicId: '__MIXMUSIC_MUSIC_ID__',
            id: '__MIXMUSIC_MUSIC_ID__',
            mid: '__MIXMUSIC_MUSIC_ID__',
            name: '__MIXMUSIC_NAME__',
            singer: '__MIXMUSIC_SINGER__',
          },
        },
      },
    ])
  } catch {
    // Some source scripts throw after starting the request; the captured shape is still usable.
  }

  const captured = source.state.captured
  if (!captured || typeof captured !== 'object') return undefined
  const request = captured as unknown as Record<string, unknown>
  return normalizeCapturedRequest(request.input, request.init)
}

const normalizeCapturedRequest = (input: unknown, init?: unknown): CapturedRequest | undefined => {
  if (typeof input === 'string') {
    return {
      url: input,
      method: normalizeMethod(readMethod(init)),
      headers: normalizeHeaders(readHeaders(init)),
      body: readBody(init),
    }
  }

  if (!input || typeof input !== 'object') return undefined
  const request = input as Record<string, unknown>
  const url = pickString(request, ['url', 'uri', 'href'])
  if (!url) return undefined

  return {
    url,
    method: normalizeMethod(pickString(request, ['method']) ?? readMethod(init)),
    headers: normalizeHeaders(request.headers ?? readHeaders(init)),
    body: stringifyBody(request.body ?? readBody(init) ?? request.data),
  }
}

const readMethod = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object') return undefined
  return pickString(value as Record<string, unknown>, ['method'])
}

const readHeaders = (value: unknown): unknown => {
  if (!value || typeof value !== 'object') return undefined
  return (value as Record<string, unknown>).headers
}

const readBody = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object') return undefined
  return stringifyBody((value as Record<string, unknown>).body)
}

const pickString = (record: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

const normalizeMethod = (method: string | undefined): string => {
  return method?.toUpperCase() ?? 'GET'
}

const normalizeHeaders = (headers: unknown): Record<string, string> => {
  const normalized: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'user-agent': 'miXmusic/1.0',
  }

  if (!headers || typeof headers !== 'object') return normalized

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') normalized[key.toLowerCase()] = value
    if (typeof value === 'number' || typeof value === 'boolean') normalized[key.toLowerCase()] = String(value)
  }

  return normalized
}

const stringifyBody = (body: unknown): string | undefined => {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  return JSON.stringify(body)
}

const extractApiKeyFromCapturedRequest = (request: CapturedRequest): string => {
  const headerKey = Object.entries(request.headers).find(([key]) => (
    key.toLowerCase() === 'x-api-key' || key.toLowerCase() === 'authorization'
  ))?.[1]
  if (headerKey) return headerKey

  try {
    const url = new URL(request.url)
    return url.searchParams.get('key') ?? url.searchParams.get('apiKey') ?? ''
  } catch {
    return ''
  }
}

const fillCapturedHeaders = (
  headers: Record<string, string>,
  musicInfo: MusicInfo,
  quality: MusicQuality,
): Record<string, string> => {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, fillCapturedTemplate(value, musicInfo, quality)]),
  )
}

const fillCapturedTemplate = (value: string, musicInfo: MusicInfo, quality: MusicQuality): string => {
  return value
    .replaceAll('__MIXMUSIC_SOURCE__', musicInfo.source)
    .replaceAll('__MIXMUSIC_MUSIC_ID__', musicInfo.songmid)
    .replaceAll('__MIXMUSIC_QUALITY__', quality)
    .replaceAll('__MIXMUSIC_NAME__', musicInfo.name)
    .replaceAll('__MIXMUSIC_SINGER__', musicInfo.singer)
}

const requestMusicUrlFromApi = async (
  config: LxApiConfig,
  musicInfo: MusicInfo,
  quality: MusicQuality,
): Promise<string> => {
  const requestUrl = fillCapturedTemplate(config.apiUrl, musicInfo, quality)
  const requestBody = config.body === undefined ? undefined : fillCapturedTemplate(config.body, musicInfo, quality)
  const response = await fetch(requestUrl, {
    method: config.method,
    headers: fillCapturedHeaders(config.headers, musicInfo, quality),
    body: requestBody,
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
