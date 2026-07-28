import type { MusicInfo, PagedResult } from '@/lib/types'
import { logServiceEvent } from '@/lib/request-log'
import { requireQQLoginState, type QQLoginState } from './account'
import { QQMusicError, qqSignedPost } from './http'
import { compactSongs, type QQSong } from './mapper'

type QQRecommendationsResponse = {
  code: number
  req?: {
    code: number
    data?: {
      tracks?: QQSong[]
      Tracks?: QQSong[]
      songlist?: QQSong[]
      v_song?: QQSong[]
      list?: Array<QQSong | { songInfo?: QQSong; songinfo?: QQSong }>
    }
  }
}

type QQRecommendFeedCard = {
  id?: string | number
  title?: string
  name?: string
  sub_title?: string
}

type QQRecommendFeedResponse = {
  code: number
  req?: {
    code: number
    data?: {
      v_shelf?: Array<{
        v_niche?: Array<{
          v_card?: QQRecommendFeedCard[]
        }>
      }>
    }
  }
}

type QQDailyPlaylistResponse = {
  code: number
  req?: {
    code: number
    data?: {
      songlist?: QQSong[]
      total_song_num?: number
    }
  }
}

export type RecommendationResult = PagedResult<MusicInfo> & {
  strategy: string
  personalized: boolean
}

const QQ_RADIO_BATCH_SIZE = 5
const QQ_RADIO_EXTRA_BATCH_ATTEMPTS = 2
const DEFAULT_QQ_RADIO_BATCH_TIMEOUT_MS = 4_000
const DEFAULT_QQ_RADIO_TOTAL_TIMEOUT_MS = 12_000
const DEFAULT_QQ_RADIO_SLOW_LOG_MS = 5_000

function common(login: QQLoginState) {
  return {
    cv: 4747474,
    ct: 24,
    format: 'json',
    uin: login.uin,
    g_tk: 5381,
  }
}

function authenticatedHeaders(login: QQLoginState) {
  return {
    cookie: login.cookie,
    referer: 'https://y.qq.com/n/ryqq/',
  }
}

function buildRecommendationsPayload(login: QQLoginState) {
  return {
    comm: common(login),
    req: {
      module: 'music.radioProxy.MbTrackRadioSvr',
      method: 'get_radio_track',
      param: {
        id: 99,
        num: QQ_RADIO_BATCH_SIZE,
        from: 0,
        scene: 0,
        song_ids: [],
      },
    },
  }
}

function extractSongs(data: QQRecommendationsResponse): QQSong[] {
  const payload = data.req?.data
  if (!payload) return []
  if (payload.tracks?.length) return payload.tracks
  if (payload.Tracks?.length) return payload.Tracks
  if (payload.songlist?.length) return payload.songlist
  if (payload.v_song?.length) return payload.v_song
  if (payload.list?.length) {
    return payload.list
      .map((item) => {
        if ('songInfo' in item) return item.songInfo
        if ('songinfo' in item) return item.songinfo
        return item
      })
      .filter((item): item is QQSong => Boolean(item))
  }
  return []
}

export async function getQQRecommendations(input: {
  cookie?: string
  limit?: number
} = {}): Promise<RecommendationResult> {
  const login = requireQQLoginState(input)
  const limit = normalizeLimit(input.limit)
  const expectedBatches = Math.ceil(limit / QQ_RADIO_BATCH_SIZE)
  const maxBatches = expectedBatches + QQ_RADIO_EXTRA_BATCH_ATTEMPTS
  const list: MusicInfo[] = []
  const seen = new Set<string>()
  const startedAt = Date.now()
  const batchTimeoutMs = positiveEnvNumber('QQ_RECOMMENDATION_BATCH_TIMEOUT_MS', DEFAULT_QQ_RADIO_BATCH_TIMEOUT_MS)
  const totalTimeoutMs = positiveEnvNumber('QQ_RECOMMENDATION_TOTAL_TIMEOUT_MS', DEFAULT_QQ_RADIO_TOTAL_TIMEOUT_MS)
  let batches = 0
  let stopReason = 'max-batches'

  for (let batch = 0; batch < maxBatches && list.length < limit; batch += 1) {
    const remainingMs = totalTimeoutMs - (Date.now() - startedAt)
    if (remainingMs <= 0) {
      if (!list.length) throw recommendationsTimeout(limit, list.length, batches)
      stopReason = 'total-timeout'
      break
    }

    let data: QQRecommendationsResponse
    try {
      data = await qqSignedPost<QQRecommendationsResponse>(
        buildRecommendationsPayload(login),
        {
          headers: authenticatedHeaders(login),
          signal: AbortSignal.timeout(Math.max(1, Math.min(batchTimeoutMs, remainingMs))),
        },
      )
      batches += 1
    } catch (error) {
      if (isTimeoutError(error)) {
        if (!list.length) throw recommendationsTimeout(limit, list.length, batches)
        stopReason = 'batch-timeout'
        break
      }
      throw error
    }
    assertBusinessSuccess(data, 'QQ recommendations request failed')

    let added = 0
    for (const song of compactSongs(extractSongs(data))) {
      const key = `${song.source}:${song.songmid}`
      if (seen.has(key)) continue
      seen.add(key)
      list.push(song)
      added += 1
      if (list.length >= limit) break
    }
    if (added === 0) {
      stopReason = 'no-new-songs'
      break
    }
    if (list.length >= limit) stopReason = 'target-reached'
  }

  if (!list.length) {
    throw new QQMusicError('QQ recommendations returned no playable songs', 502, {
      requested: limit,
      maxBatches,
    })
  }

  const durationMs = Date.now() - startedAt
  const slowLogMs = positiveEnvNumber('QQ_RECOMMENDATION_SLOW_LOG_MS', DEFAULT_QQ_RADIO_SLOW_LOG_MS)
  if (durationMs >= slowLogMs || recommendationLogsEnabled() || stopReason.includes('timeout')) {
    logServiceEvent('qq_recommendations_loaded', {
      requested: limit,
      returned: Math.min(list.length, limit),
      batches,
      durationMs,
      stopReason,
    })
  }

  return paged(list.slice(0, limit), limit, 'qq-radio:99')
}

function recommendationsTimeout(requested: number, collected: number, batches: number): QQMusicError {
  return new QQMusicError('QQ recommendations request timed out', 504, {
    code: 'QQ_RECOMMENDATIONS_TIMEOUT',
    requested,
    collected,
    batches,
  })
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

function recommendationLogsEnabled(): boolean {
  return ['1', 'true', 'on', 'yes'].includes(process.env.X_MUSIC_QQ_RECOMMENDATION_LOGS?.trim().toLowerCase() ?? '')
}

function positiveEnvNumber(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export async function getQQDailyRecommendations(input: {
  cookie?: string
  limit?: number
} = {}): Promise<RecommendationResult> {
  const login = requireQQLoginState(input)
  const limit = normalizeLimit(input.limit)
  const feed = await qqSignedPost<QQRecommendFeedResponse>({
    comm: common(login),
    req: {
      module: 'music.recommend.RecommendFeed',
      method: 'get_recommend_feed',
      param: {},
    },
  }, { headers: authenticatedHeaders(login) })

  assertBusinessSuccess(feed, 'QQ recommendation feed request failed')
  const playlistId = findDailyPlaylistId(feed)
  if (!playlistId) {
    throw new QQMusicError('QQ daily recommendations are unavailable', 502, {
      code: feed.code,
      requestCode: feed.req?.code,
      actionable: 'The current QQ recommendation feed did not include a daily recommendation card.',
    })
  }

  const detail = await qqSignedPost<QQDailyPlaylistResponse>({
    comm: common(login),
    req: {
      module: 'music.srfDissInfo.DissInfo',
      method: 'CgiGetDiss',
      param: {
        disstid: Number(playlistId),
        dirid: 1,
        tag: 1,
        song_begin: 0,
        song_num: limit,
        userinfo: 1,
        orderlist: 1,
        onlysong: 0,
      },
    },
  }, { headers: authenticatedHeaders(login) })

  assertBusinessSuccess(detail, 'QQ daily playlist request failed')
  const list = compactSongs(detail.req?.data?.songlist ?? []).slice(0, limit)
  if (!list.length) {
    throw new QQMusicError('QQ daily recommendations returned no playable songs', 502, {
      code: detail.code,
      requestCode: detail.req?.code,
      playlistId,
    })
  }

  return paged(list, limit, `qq-daily:${playlistId}`)
}

function findDailyPlaylistId(feed: QQRecommendFeedResponse): string | undefined {
  const cards = feed.req?.data?.v_shelf
    ?.flatMap(shelf => shelf.v_niche ?? [])
    .flatMap(niche => niche.v_card ?? []) ?? []

  const card = cards.find((item) => isDailyRecommendationTitle([
    item.title,
    item.name,
    item.sub_title,
  ].filter(Boolean).join(' ')))
  const id = card?.id === undefined ? '' : String(card.id)
  return /^\d+$/.test(id) ? id : undefined
}

function isDailyRecommendationTitle(value: string): boolean {
  const title = value.replace(/\s+/g, '').toLowerCase()
  return title.includes('每日30首')
    || title.includes('每日推荐')
    || title.includes('今日推荐')
    || title.includes('daily30')
    || title.includes('dailyrecommend')
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

function normalizeLimit(value?: number): number {
  if (!Number.isFinite(value) || !value) return 30
  return Math.min(Math.max(Math.trunc(value), 1), 100)
}

function paged(list: MusicInfo[], limit: number, strategy: string): RecommendationResult {
  return {
    source: 'tx',
    list,
    page: 1,
    limit,
    total: list.length,
    allPage: 1,
    strategy,
    personalized: true,
  }
}
