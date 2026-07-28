import { ensureTrack, insertPlayEvent, upsertTrackFileStatus } from '@/lib/cache/store'
import { createUpstreamTeeResponse } from '@/lib/cache/stream'
import { encryptedQQAudioRequiresKeyMessage, isEncryptedQQAudioFileName, isEncryptedQQAudioRequiresKeyError } from '@/lib/cache/decrypt'
import { ensureEmbyMasterCachedBestEffort } from '@/lib/emby/master'
import { isMusicUrlUnavailableMessage, MusicUrlConfigError, MusicUrlResolveError, parseRequestedQuality, qualityFallbacks, resolveMusicUrl } from '@/lib/music-url/resolve'
import { isHighestAvailableQuality } from '@/lib/quality'
import { syncQQPlayHistoryBestEffort } from '@/lib/qq'
import { logCompletedRequest, logFailedRequest, markRequestSource } from '@/lib/request-log'
import { getCurrentAccount } from '@/lib/session'
import type { AccountRecord } from '@/lib/db/accounts'
import type { MusicInfo, MusicQuality, OnlineSource } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type PlayRequest = Partial<MusicInfo> & {
  quality?: string
  source?: string
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  return handleLoggedPlayRequest(request, Object.fromEntries(url.searchParams.entries()))
}

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return jsonError('POST /api/play expects application/json', 415)
  }

  const body = (await request.json().catch(() => undefined)) as PlayRequest | undefined
  if (!body) return jsonError('Invalid JSON body', 400)

  return handleLoggedPlayRequest(request, body)
}

const handleLoggedPlayRequest = async (request: Request, input: PlayRequest): Promise<Response> => {
  const startedAt = Date.now()
  try {
    const response = await handlePlayRequest(request, input)
    return logCompletedRequest(request, response, startedAt, {
      route: '/api/play',
      songmid: typeof input.songmid === 'string' ? input.songmid : undefined,
      quality: typeof input.quality === 'string' ? input.quality : undefined,
    })
  } catch (error) {
    logFailedRequest(request, startedAt, error, { route: '/api/play' })
    throw error
  }
}

const handlePlayRequest = async (request: Request, input: PlayRequest): Promise<Response> => {
  const musicInfo = parseMusicInfo(input)
  if (!musicInfo) return jsonError('Missing required parameters: source, songmid, name, singer', 400)

  const requestedQuality = parseRequestedQuality(input.quality)
  const preferredQuality = requestedQuality ?? 'flac'
  const shouldRecordPlayback = isPlaybackStartRequest(request)
  const account = await getCurrentAccount()
  if (!account) return jsonError('Login required', 401)

  const track = ensureTrack(musicInfo)
  try {
    const resolved = await resolvePlayableUpstreamResponse(musicInfo, preferredQuality, track, request, account)
    if (shouldRecordPlayback) {
      insertPlayEvent(track.id, resolved.quality, account.userId)
      syncQQPlayHistoryBestEffort({
        cookie: account.qqCookie,
        musicInfo,
      })
    }
    if (!isHighestAvailableQuality(musicInfo, resolved.quality)) {
      ensureEmbyMasterCachedBestEffort({ musicInfo, track })
    }

    resolved.completion.catch((error: unknown) => {
      upsertTrackFileStatus(track.id, resolved.quality, 'failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })

    return markRequestSource(resolved.response, 'upstream')
  } catch (error) {
    const message = playbackErrorMessage(error)
    upsertTrackFileStatus(track.id, preferredQuality, 'failed', {
      error: message,
    })
    return jsonError(message, isUnplayableResolveError(error) ? 451 : 502)
  }
}

const resolvePlayableUpstreamResponse = async (
  musicInfo: MusicInfo,
  preferredQuality: MusicQuality,
  track: ReturnType<typeof ensureTrack>,
  request: Request,
  account?: AccountRecord,
): Promise<{
  url: string
  quality: MusicQuality
  response: Response
  completion: Promise<void>
}> => {
  const attempts: Array<{ quality: MusicQuality; error: string; source?: string; musicId?: string }> = []
  let encryptedQQRequiresKey = false

  for (const quality of qualityFallbacks(preferredQuality)) {
    upsertTrackFileStatus(track.id, quality, 'resolving_url')
    try {
      const resolved = await resolveMusicUrl(musicInfo, quality)
      if (encryptedQQRequiresKey && isEncryptedQQAudioFileName(resolved.url)) {
        const message = 'Skipped encrypted QQ audio because a previous encrypted quality already required a local QQ Music key'
        attempts.push({ quality, error: message })
        upsertTrackFileStatus(track.id, quality, 'failed', { error: message })
        continue
      }
      if (!isEncryptedQQAudioFileName(resolved.url)) {
        upsertTrackFileStatus(track.id, resolved.quality, 'failed', {
          error: 'Redirected to non-encrypted upstream without local cache',
        })
        return {
          url: resolved.url,
          quality: resolved.quality,
          response: redirectToAudioUrl(resolved.url),
          completion: Promise.resolve(),
        }
      }
      const { response, completion } = await createUpstreamTeeResponse(
        resolved.url,
        track,
        resolved.quality,
        request,
        resolved.ekey,
        {
          librarySync: isHighestAvailableQuality(musicInfo, resolved.quality),
          userId: account?.userId,
        },
      )
      return {
        url: resolved.url,
        quality: resolved.quality,
        response,
        completion,
      }
    } catch (error) {
      if (error instanceof MusicUrlConfigError) throw error
      const message = musicUrlErrorMessage(error)
      if (error instanceof MusicUrlResolveError) {
        attempts.push(...error.attempts)
      } else {
        attempts.push({ quality, error: message })
      }
      upsertTrackFileStatus(track.id, quality, 'failed', { error: message })
      if (isEncryptedQQAudioRequiresKeyError(error)) encryptedQQRequiresKey = true
    }
  }

  throw new MusicUrlResolveError('Unable to resolve a playable music URL', attempts)
}

function redirectToAudioUrl(url: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: url,
      'cache-control': 'no-store',
      'x-x-music-stream-mode': 'redirect',
    },
  })
}

const isPlaybackStartRequest = (request: Request): boolean => {
  const range = request.headers.get('range')
  if (!range) return true

  const match = /^bytes=(\d*)-/.exec(range.trim())
  return match?.[1] === '0'
}

const playbackErrorMessage = (error: unknown): string => {
  if (error instanceof MusicUrlConfigError) {
    return `${error.message}. Set LX_MUSIC_SOURCE_SCRIPT to the LX source script URL; XMusic will simulate the source request handler and call the captured API shape directly.`
  }

  if (error instanceof MusicUrlResolveError) {
    const detail = error.attempts.map((attempt) => `${attempt.quality}${attempt.source ? `/${attempt.source}` : ''}: ${attempt.error}`).join('; ')
    if (error.attempts.some(attempt => attempt.error.includes('QQ encrypted audio requires a matching QQ Music local key'))) {
      return `${encryptedQQAudioRequiresKeyMessage} ${detail}`
    }
    return `Unable to resolve a playable music URL. ${detail}`
  }

  return error instanceof Error ? error.message : 'Unable to play track'
}

function musicUrlErrorMessage(error: unknown): string {
  if (error instanceof MusicUrlResolveError && error.attempts.length) {
    return error.attempts
      .map(attempt => `${attempt.source ? `${attempt.source}: ` : ''}${attempt.error}`)
      .join('; ')
  }
  return error instanceof Error ? error.message : String(error)
}

function isUnplayableResolveError(error: unknown): boolean {
  if (!(error instanceof MusicUrlResolveError)) return false
  return error.attempts.length > 0 && error.attempts.every(attempt => isMusicUrlUnavailableAttempt(attempt.error))
}

function isMusicUrlUnavailableAttempt(message: string): boolean {
  if (isMusicUrlUnavailableMessage(message)) return true
  return message.includes('Unable to resolve a playable music URL')
    && message.includes('未获取到URL')
}

const parseMusicInfo = (input: PlayRequest): MusicInfo | undefined => {
  if (input.source !== 'tx') return undefined
  if (!isNonEmptyString(input.songmid) || !isNonEmptyString(input.name) || !isNonEmptyString(input.singer)) {
    return undefined
  }

  return {
    source: input.source as OnlineSource,
    songmid: input.songmid,
    name: input.name,
    singer: input.singer,
    albumName: normalizeOptional(input.albumName),
    albumId: normalizeOptional(input.albumId),
    interval: normalizeOptional(input.interval),
    img: normalizeOptional(input.img),
    raw: input,
  }
}

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === 'string' && value.trim().length > 0
}

const normalizeOptional = (value: unknown): string | undefined => {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const jsonError = (message: string, status: number): Response => {
  return Response.json({ error: message }, { status })
}
