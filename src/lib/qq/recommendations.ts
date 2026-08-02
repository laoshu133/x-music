import { createHash, randomUUID } from 'node:crypto'
import type { MusicInfo, PagedResult } from '@/lib/types'
import type { AccountRecord } from '@/lib/db/accounts'
import { logServiceEvent } from '@/lib/request-log'
import { parseQQCookieText, requireQQLoginState, type QQLoginState } from './account'
import { markQQAccountAuthorizationExpired, QQAuthExpiredError } from './auth-state'
import { refreshAccountQQAuthorization } from './auth-refresh'
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

type QQRadioSessionResponse = {
  code: number
  req?: {
    code: number
    data?: {
      session?: {
        uid?: string | number
        sid?: string
        vkey?: string | number
      }
    }
  }
}

type QQRadioSession = {
  uid: string
  sid: string
  deviceId: string
  expiresAt: number
}

type QQRadioSessionLookup = {
  session: QQRadioSession
  cached: boolean
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
const QQ_RADIO_AUTH_EXPIRED_CODES = new Set([1000, 104400, 104401])
const QQ_RADIO_SESSION_RETRY_CODES = new Set([1000])
const QQ_RADIO_AUTH_RETRY_COOLDOWN_MS = 10 * 60 * 1000
const QQ_RADIO_SESSION_TTL_MS = 23 * 60 * 60 * 1000
const DEFAULT_QQ_RADIO_BATCH_TIMEOUT_MS = 4_000
const DEFAULT_QQ_RADIO_TOTAL_TIMEOUT_MS = 12_000
const DEFAULT_QQ_RADIO_SLOW_LOG_MS = 5_000

type QQRadioAuthFailure = {
  cookie: string
  failedAt: number
}

const qqRadioAuthFailures = new Map<string, QQRadioAuthFailure>()
const qqRadioSessions = new Map<string, QQRadioSession>()
const qqRadioSessionRequests = new Map<string, Promise<QQRadioSession>>()
const qqRadioDeviceIds = new Map<string, string>()

export class QQRecommendationAuthError extends QQMusicError {
  constructor(payload: Record<string, unknown> = {}) {
    super('QQ 猜你喜欢暂时无法验证当前授权。', 428, {
      ...payload,
      code: 'QQ_RECOMMENDATION_AUTH_REQUIRED',
      actionable: '请在设置中刷新或重新绑定 QQ 音乐授权；其他 QQ 音乐功能不受影响。',
    })
    this.name = 'QQRecommendationAuthError'
  }
}

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

function buildRecommendationsPayload(login: QQLoginState, session: QQRadioSession) {
  return {
    comm: androidCommon(login, session),
    req: {
      module: 'music.radioProxy.MbTrackRadioSvr',
      method: 'get_radio_track',
      param: {
        id: 99,
        num: QQ_RADIO_BATCH_SIZE,
        from: 0,
        scene: 0,
        song_ids: [],
        should_count_down: 0,
        ext: {
          USER_APPFRONT_STATUS: '1',
          USER_PLAYPAGEFRONT_STATUS: '0',
          IMMERSED_PLAYER: '1',
          ENABLE_VIDEO: '1',
          song_play_status: '0',
          recent_play_song_list: '',
          bluetooth: '',
        },
      },
    },
  }
}

function androidCommon(login: QQLoginState, session?: QQRadioSession) {
  const deviceId = session?.deviceId ?? getQQRadioDeviceId(login.uin)
  return {
    ct: 11,
    cv: 14090008,
    v: 14090008,
    chid: '10003505',
    qq: login.uin,
    authst: login.qqmusicKey,
    tmeAppID: 'qqmusic',
    tmeLoginType: qqLoginType(login),
    QIMEI: '',
    QIMEI36: '',
    OpenUDID: deviceId,
    OpenUDID2: deviceId,
    udid: deviceId,
    uid: session?.uid ?? '',
    sid: session?.sid ?? '',
    aid: '',
    os_ver: '12',
    phonetype: 'XMusic',
    devicelevel: '31',
    newdevicelevel: '31',
    rom: 'XMusic',
  }
}

async function requestQQRadioBatch(
  login: QQLoginState,
  signal: AbortSignal,
): Promise<QQRecommendationsResponse> {
  let lookup = await getQQRadioSession(login, signal)
  let data = await qqSignedPost<QQRecommendationsResponse>(
    buildRecommendationsPayload(login, lookup.session),
    { headers: authenticatedHeaders(login), signal },
  )

  if (lookup.cached && QQ_RADIO_SESSION_RETRY_CODES.has(data.req?.code ?? 0)) {
    invalidateQQRadioSession(login)
    lookup = await getQQRadioSession(login, signal)
    data = await qqSignedPost<QQRecommendationsResponse>(
      buildRecommendationsPayload(login, lookup.session),
      { headers: authenticatedHeaders(login), signal },
    )
  }

  return data
}

async function getQQRadioSession(
  login: QQLoginState,
  signal: AbortSignal,
): Promise<QQRadioSessionLookup> {
  if (!login.qqmusicKey) {
    throw new QQRecommendationAuthError({ missingQQMusicKey: true })
  }

  const cacheKey = qqRadioSessionCacheKey(login)
  const cached = qqRadioSessions.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return { session: cached, cached: true }
  if (cached) qqRadioSessions.delete(cacheKey)

  let pending = qqRadioSessionRequests.get(cacheKey)
  if (!pending) {
    pending = createQQRadioSession(login, signal)
    qqRadioSessionRequests.set(cacheKey, pending)
    void pending.finally(() => qqRadioSessionRequests.delete(cacheKey)).catch(() => undefined)
  }

  const session = await pending
  qqRadioSessions.set(cacheKey, session)
  return { session, cached: false }
}

async function createQQRadioSession(
  login: QQLoginState,
  signal: AbortSignal,
): Promise<QQRadioSession> {
  const data = await qqSignedPost<QQRadioSessionResponse>({
    comm: androidCommon(login),
    req: {
      module: 'music.getSession.session',
      method: 'GetSession',
      param: { uid: '', vkey: 0, caller: 0 },
    },
  }, { headers: authenticatedHeaders(login), signal })

  const upstreamCode = data.code
  const upstreamRequestCode = data.req?.code
  const rawSession = data.req?.data?.session
  const uid = String(rawSession?.uid ?? '').trim()
  const sid = String(rawSession?.sid ?? '').trim()
  if (upstreamCode !== 0 || upstreamRequestCode !== 0 || !uid || uid === '0' || !sid) {
    if (QQ_RADIO_AUTH_EXPIRED_CODES.has(upstreamRequestCode ?? 0)) {
      throw new QQRecommendationAuthError({
        phase: 'session',
        upstreamCode,
        upstreamRequestCode,
      })
    }
    throw new QQMusicError('QQ recommendation device session request failed', 502, {
      code: upstreamCode,
      requestCode: upstreamRequestCode,
      hasUid: Boolean(uid && uid !== '0'),
      hasSid: Boolean(sid),
    })
  }

  return {
    uid,
    sid,
    deviceId: getQQRadioDeviceId(login.uin),
    expiresAt: Date.now() + QQ_RADIO_SESSION_TTL_MS,
  }
}

function qqRadioSessionCacheKey(login: Pick<QQLoginState, 'uin' | 'qqmusicKey'>): string {
  return `${login.uin}:${qqRadioCredentialFingerprint(login)}`
}

function qqRadioCredentialFingerprint(login: Pick<QQLoginState, 'uin' | 'qqmusicKey'>): string {
  return createHash('sha256')
    .update(login.uin)
    .update('\0')
    .update(login.qqmusicKey ?? '')
    .digest('base64url')
}

function getQQRadioDeviceId(uin: string): string {
  const cached = qqRadioDeviceIds.get(uin)
  if (cached) return cached
  const value = randomUUID().replaceAll('-', '')
  qqRadioDeviceIds.set(uin, value)
  return value
}

function qqLoginType(login: QQLoginState): number {
  const value = Number(parseQQCookieText(login.cookie).get('tmeLoginType'))
  if (Number.isInteger(value) && value > 0) return value
  return login.qqmusicKey?.startsWith('W_X') ? 1 : 2
}

function invalidateQQRadioSession(login: Pick<QQLoginState, 'uin' | 'qqmusicKey'>): void {
  qqRadioSessions.delete(qqRadioSessionCacheKey(login))
}

function invalidateQQRadioSessionsForUin(uin: string): void {
  for (const cacheKey of qqRadioSessions.keys()) {
    if (cacheKey.startsWith(`${uin}:`)) qqRadioSessions.delete(cacheKey)
  }
}

export function clearQQRecommendationSessionCache(): void {
  qqRadioSessions.clear()
  qqRadioSessionRequests.clear()
  qqRadioDeviceIds.clear()
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
      data = await requestQQRadioBatch(
        login,
        AbortSignal.timeout(Math.max(1, Math.min(batchTimeoutMs, remainingMs))),
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
    assertRecommendationsBusinessSuccess(data)

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
  if (durationMs >= slowLogMs || stopReason.includes('timeout')) {
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

export async function getQQRecommendationsForAccount(
  account: AccountRecord,
  input: { limit?: number } = {},
): Promise<RecommendationResult> {
  const recentFailure = qqRadioAuthFailures.get(account.userId)
  if (recentFailure?.cookie === account.qqCookie
    && Date.now() - recentFailure.failedAt < QQ_RADIO_AUTH_RETRY_COOLDOWN_MS) {
    throw new QQRecommendationAuthError({ retrySuppressed: true })
  }
  if (recentFailure) qqRadioAuthFailures.delete(account.userId)

  try {
    const result = await getQQRecommendations({ cookie: account.qqCookie, limit: input.limit })
    qqRadioAuthFailures.delete(account.userId)
    return result
  } catch (error) {
    if (!(error instanceof QQRecommendationAuthError)) throw error
  }

  let refreshed: Awaited<ReturnType<typeof refreshAccountQQAuthorization>>
  try {
    refreshed = await refreshAccountQQAuthorization(account)
  } catch (error) {
    if (isDefinitiveRefreshAuthFailure(error)) {
      throw markQQAccountAuthorizationExpired(account, error)
    }
    rememberQQRadioAuthFailure(account.userId, account.qqCookie)
    logServiceEvent('qq_recommendation_auth_refresh_failed', {
      userId: account.userId,
      error: error instanceof Error ? error.message : String(error),
      status: error instanceof QQMusicError ? error.status : undefined,
    }, 'error')
    throw new QQRecommendationAuthError({ refreshFailed: true })
  }

  invalidateQQRadioSessionsForUin(account.qqUin)

  try {
    const result = await getQQRecommendations({
      cookie: refreshed.account.qqCookie,
      limit: input.limit,
    })
    qqRadioAuthFailures.delete(account.userId)
    return result
  } catch (error) {
    if (error instanceof QQRecommendationAuthError) {
      rememberQQRadioAuthFailure(account.userId, refreshed.account.qqCookie)
      logServiceEvent('qq_recommendation_auth_retry_failed', {
        userId: account.userId,
        refreshChanged: refreshed.result.changed,
        keyRefreshed: refreshed.result.keyRefreshed,
        tokenRefreshed: refreshed.result.tokenRefreshed,
      }, 'error')
    }
    throw error
  }
}

function rememberQQRadioAuthFailure(userId: string, cookie: string): void {
  qqRadioAuthFailures.set(userId, { cookie, failedAt: Date.now() })
}

function isDefinitiveRefreshAuthFailure(error: unknown): boolean {
  return error instanceof QQAuthExpiredError
    || (error instanceof QQMusicError && error.status === 401)
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

function assertRecommendationsBusinessSuccess(data: QQRecommendationsResponse): void {
  const requestCode = data.req?.code
  if (requestCode !== undefined && QQ_RADIO_AUTH_EXPIRED_CODES.has(requestCode)) {
    throw new QQRecommendationAuthError({
      upstreamCode: data.code,
      upstreamRequestCode: requestCode,
    })
  }
  assertBusinessSuccess(data, 'QQ recommendations request failed')
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
