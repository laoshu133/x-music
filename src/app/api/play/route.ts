import { ensureTrack, getPlayableTrackFile, insertPlayEvent, upsertTrackFileStatus } from '@/lib/cache/store'
import { createUpstreamTeeResponse, streamLocalFile } from '@/lib/cache/stream'
import { MusicUrlConfigError, MusicUrlResolveError, parseRequestedQuality, qualityFallbacks, resolveMusicUrlWithFallback } from '@/lib/music-url/resolve'
import { getQQLoginState, syncQQPlayHistoryBestEffort } from '@/lib/qq'
import type { MusicInfo, MusicQuality, OnlineSource } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type PlayRequest = Partial<MusicInfo> & {
  quality?: string
  source?: string
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  return handlePlayRequest(request, Object.fromEntries(url.searchParams.entries()))
}

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return jsonError('POST /api/play expects application/json', 415)
  }

  const body = (await request.json().catch(() => undefined)) as PlayRequest | undefined
  if (!body) return jsonError('Invalid JSON body', 400)

  return handlePlayRequest(request, body)
}

const handlePlayRequest = async (request: Request, input: PlayRequest): Promise<Response> => {
  const musicInfo = parseMusicInfo(input)
  if (!musicInfo) return jsonError('Missing required parameters: source, songmid, name, singer', 400)

  const requestedQuality = parseRequestedQuality(input.quality)
  const preferredQuality = requestedQuality ?? 'flac'
  const shouldRecordPlayback = isPlaybackStartRequest(request)

  const playableFile = qualityFallbacks(preferredQuality)
    .map((quality) => getPlayableTrackFile(musicInfo.source, musicInfo.songmid, quality))
    .find((file) => file !== undefined)
  const localPath = playableFile?.finalPath ?? playableFile?.rawPath
  if (playableFile && localPath) {
    if (shouldRecordPlayback) {
      const track = ensureTrack(musicInfo)
      insertPlayEvent(track.id, playableFile.quality)
      syncQQPlayHistoryFromResolvedUrlBestEffort({
        cookie: request.headers.get('x-qq-music-cookie') ?? undefined,
        musicInfo,
        quality: playableFile.quality,
      })
    }
    return streamLocalFile(localPath, request)
  }

  const track = ensureTrack(musicInfo)
  upsertTrackFileStatus(track.id, preferredQuality, 'resolving_url')

  try {
    const resolved = await resolveMusicUrlWithFallback(musicInfo, preferredQuality)
    if (shouldRecordPlayback) {
      insertPlayEvent(track.id, resolved.quality)
      syncQQPlayHistoryBestEffort({
        cookie: request.headers.get('x-qq-music-cookie') ?? undefined,
        musicInfo,
        quality: resolved.quality,
        playUrl: resolved.url,
      })
    }
    const { response, completion } = await createUpstreamTeeResponse(resolved.url, track, resolved.quality, request)

    completion.catch((error: unknown) => {
      upsertTrackFileStatus(track.id, resolved.quality, 'failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })

    return response
  } catch (error) {
    const message = playbackErrorMessage(error)
    upsertTrackFileStatus(track.id, preferredQuality, 'failed', {
      error: message,
    })
    return jsonError(message, 502)
  }
}

const isPlaybackStartRequest = (request: Request): boolean => {
  const range = request.headers.get('range')
  if (!range) return true

  const match = /^bytes=(\d*)-/.exec(range.trim())
  return match?.[1] === '0'
}

function syncQQPlayHistoryFromResolvedUrlBestEffort(input: {
  cookie?: string
  musicInfo: MusicInfo
  quality: MusicQuality
}): void {
  try {
    if (!getQQLoginState({ cookie: input.cookie })) return
  } catch (error) {
    console.warn(
      `QQ play history sync skipped for ${input.musicInfo.songmid}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }

  void resolveMusicUrlWithFallback(input.musicInfo, input.quality).then((resolved) => {
    syncQQPlayHistoryBestEffort({
      ...input,
      quality: resolved.quality,
      playUrl: resolved.url,
    })
  }).catch((error: unknown) => {
    console.warn(
      `QQ play history URL resolve failed for ${input.musicInfo.songmid}: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
}

const playbackErrorMessage = (error: unknown): string => {
  if (error instanceof MusicUrlConfigError) {
    return `${error.message}. Set LX_MUSIC_SOURCE_SCRIPT to the LX source script URL; miXmusic will simulate the source request handler and call the captured API shape directly.`
  }

  if (error instanceof MusicUrlResolveError) {
    const detail = error.attempts.map((attempt) => `${attempt.quality}: ${attempt.error}`).join('; ')
    return `Unable to resolve a playable music URL. ${detail}`
  }

  return error instanceof Error ? error.message : 'Unable to play track'
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
