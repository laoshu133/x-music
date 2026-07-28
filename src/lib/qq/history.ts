import type { MusicInfo, MusicQuality } from '@/lib/types'
import { getQQLoginState, requireQQLoginState, type QQLoginState } from './account'
import { QQMusicError, qqSignedPost } from './http'
import type { QQSong } from './mapper'

type QQPlayHistoryResponse<T> = {
  code: number
  req?: {
    code: number
    data?: T
  }
}

type QQPlayHistoryReadData = {
  type?: number
  code?: number
  updateTime?: number
  data?: {
    songList?: QQRemotePlayHistoryItem[]
  }
}

export type QQRemotePlayHistoryItem = {
  track?: QQSong
  lastTime?: number | string
  listenCnt?: number
}

export type QQPlayHistorySyncResult =
  | { synced: true; skipped?: false; raw?: unknown }
  | { synced: false; skipped: true; reason: string }
  | { synced: false; skipped?: false; error: string; raw?: unknown }

function common(login: QQLoginState) {
  return {
    cv: 4747474,
    ct: 24,
    format: 'json',
    uin: login.uin,
    g_tk: 5381,
  }
}

function requestOptions(login: QQLoginState) {
  return {
    headers: {
      cookie: login.cookie,
      referer: 'https://y.qq.com/n/ryqq/',
    },
  }
}

function resolveNumericSongId(musicInfo: MusicInfo): number | undefined {
  const raw = musicInfo.raw
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>

  for (const key of ['songId', 'songid', 'song_id', 'id', 'backendSongId']) {
    const value = record[key]
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
  }
  return undefined
}

function unixSeconds(value?: string | Date | number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.trunc(value > 10_000_000_000 ? value / 1000 : value))
  }
  const milliseconds = value instanceof Date
    ? value.getTime()
    : typeof value === 'string'
      ? Date.parse(value)
      : Date.now()
  return Math.max(1, Math.trunc((Number.isFinite(milliseconds) ? milliseconds : Date.now()) / 1000))
}

function assertBusinessSuccess(
  data: { code: number; req?: { code: number } },
  message: string,
): void {
  if (data.code === 0 && data.req?.code === 0) return
  throw new QQMusicError(message, 502, {
    code: data.code,
    requestCode: data.req?.code,
  })
}

async function reportQQPlayHistory(input: {
  login: QQLoginState
  songId: number
  playedAt?: string | Date | number
}) {
  const body = {
    comm: common(input.login),
    req: {
      module: 'music.musicasset.PlayRecentlyWrite',
      method: 'ReportPlayRecentlyInfo',
      param: {
        data: [{
          id: String(input.songId),
          type: 2,
          lastTime: unixSeconds(input.playedAt),
          listenCnt: 1,
        }],
      },
    },
  }
  const data = await qqSignedPost<QQPlayHistoryResponse<unknown>>(body, requestOptions(input.login))
  assertBusinessSuccess(data, 'QQ play history report request failed')
  return data
}

export async function getQQPlayHistory(input: {
  cookie?: string
  limit?: number
} = {}): Promise<{
  list: QQRemotePlayHistoryItem[]
  updateTime?: number
}> {
  const login = requireQQLoginState(input)
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50) || 50, 1), 200)
  const data = await qqSignedPost<QQPlayHistoryResponse<QQPlayHistoryReadData>>({
    comm: common(login),
    req: {
      module: 'music.musicasset.PlayRecentlyRead',
      method: 'GetPlayRecentlyInfo',
      param: { type: 2, count: limit },
    },
  }, requestOptions(login))

  assertBusinessSuccess(data, 'QQ play history read request failed')
  const requestData = data.req?.data
  if (requestData?.code !== undefined && requestData.code !== 0) {
    throw new QQMusicError('QQ play history read returned a business error', 502, {
      code: data.code,
      requestCode: data.req?.code,
      historyCode: requestData.code,
    })
  }
  return {
    list: requestData?.data?.songList ?? [],
    updateTime: requestData?.updateTime,
  }
}

export async function syncQQPlayHistory(input: {
  cookie?: string
  musicInfo: MusicInfo
  quality?: MusicQuality
  playUrl?: string
  playedAt?: string | Date | number
}): Promise<QQPlayHistorySyncResult> {
  const login = getQQLoginState(input)
  if (!login) {
    return { synced: false, skipped: true, reason: 'QQ Music login cookie is not configured' }
  }
  const songId = resolveNumericSongId(input.musicInfo)
  if (!songId) {
    return { synced: false, skipped: true, reason: 'QQ play history sync requires a numeric songId in musicInfo.raw' }
  }

  try {
    const raw = await reportQQPlayHistory({
      login,
      songId,
      playedAt: input.playedAt,
    })
    return { synced: true, raw }
  } catch (error) {
    return {
      synced: false,
      error: error instanceof Error ? error.message : String(error),
      raw: error instanceof QQMusicError ? error.payload : undefined,
    }
  }
}

export function syncQQPlayHistoryBestEffort(input: {
  cookie?: string
  musicInfo: MusicInfo
  quality?: MusicQuality
  playUrl?: string
  playedAt?: string | Date | number
}): void {
  void syncQQPlayHistory(input).then((result) => {
    if (!result.synced) {
      const detail = result.skipped ? result.reason : result.error
      if (process.env.X_MUSIC_DEBUG_BACKGROUND_SYNC === '1') {
        console.debug(`QQ play history sync skipped/failed for ${input.musicInfo.songmid}: ${detail}`)
      }
    }
  }).catch((error: unknown) => {
    if (process.env.X_MUSIC_DEBUG_BACKGROUND_SYNC === '1') {
      console.debug(
        `QQ play history sync crashed for ${input.musicInfo.songmid}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })
}
