import type { MusicInfo, MusicQuality } from '@/lib/types'
import { getQQLoginState, parseQQCookieText, type QQLoginState } from './account'
import { QQMusicError } from './http'

const PLAY_HISTORY_REPORT_URL = 'https://stat6.y.qq.com/sdk/fcgi-bin/sdk.fcg'
const PLAYER_PAGE_URL = 'https://y.qq.com/n/ryqq_v2/player'
const REPORT_FQM_ID = '7642c64d-5680-42a8-b8be-b2a114021486'
const SDK_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'

type PlayHistorySongInfo = {
  songId?: number
  songType?: number
  raw?: unknown
}

export type QQPlayHistorySyncResult =
  | { synced: true; skipped?: false; raw?: unknown }
  | { synced: false; skipped: true; reason: string }
  | { synced: false; skipped?: false; error: string; raw?: unknown }

function resolveSongId(input: PlayHistorySongInfo): number {
  const fromRaw = readRawNumber(input.raw, ['songId', 'songid', 'song_id', 'id', 'backendSongId'])
  return input.songId ?? fromRaw ?? 0
}

function resolveSongType(input: PlayHistorySongInfo): number {
  return input.songType ?? readRawNumber(input.raw, ['songType', 'songtype', 'song_type', 'type']) ?? 0
}

function readRawNumber(raw: unknown, keys: string[]): number | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>

  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }

  return undefined
}

function accountSource(login: QQLoginState): string {
  const cookies = parseQQCookieText(login.cookie)
  const loginType = cookies.get('login_type') ?? cookies.get('tmeLoginType')
  return loginType && /^\d+$/.test(loginType) ? loginType : '1'
}

function unixSeconds(): string {
  return String(Math.floor(Date.now() / 1000))
}

function reportId(): string {
  return `${Date.now()}${Math.floor(100000000000 + Math.random() * 900000000000)}`
}

function buildPlayHistoryReportBody(input: {
  login: QQLoginState
  musicInfo: MusicInfo
  playUrl: string
}) {
  const now = unixSeconds()
  const rawSong = { raw: input.musicInfo.raw }
  return {
    common: {
      _appid: 'qqmusic',
      _uid: Number(input.login.uin),
      _platform: 11,
      _account_source: accountSource(input.login),
      _os_version: '',
      _app_version: 0,
      _channelid: '',
      _os: 'mac',
      _app: 'mac',
      _opertime: now,
      _network_type: 'unknown',
      fqm_id: REPORT_FQM_ID,
    },
    items: [
      {
        _key: 'webcomm',
        _opertime: now,
        cmd: '25',
        int1: 3,
        str1: input.login.uin,
        int2: resolveSongId(rawSong),
        str2: 'PC',
        int3: resolveSongType(rawSong),
        str3: 'other',
        int4: 0,
        str5: reportId(),
        str6: reportId(),
        str7: '',
        str8: '',
        str9: input.playUrl,
        str10: PLAYER_PAGE_URL,
      },
    ],
  }
}

async function reportQQSdkPlay(input: {
  login: QQLoginState
  musicInfo: MusicInfo
  playUrl: string
}) {
  const body = buildPlayHistoryReportBody(input)
  const response = await fetch(PLAY_HISTORY_REPORT_URL, {
    method: 'POST',
    headers: {
      accept: '*/*',
      'content-type': 'text/plain;charset=UTF-8',
      cookie: input.login.cookie,
      origin: 'https://y.qq.com',
      referer: PLAYER_PAGE_URL,
      'user-agent': SDK_USER_AGENT,
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw new QQMusicError('QQ play history sdk report request failed', response.status, {
      body: text.slice(0, 500),
      request: body,
    })
  }

  return {
    status: response.status,
    body: text.slice(0, 500),
    request: body,
  }
}

export async function syncQQPlayHistory(input: {
  cookie?: string
  musicInfo: MusicInfo
  quality: MusicQuality
  playUrl?: string
}): Promise<QQPlayHistorySyncResult> {
  const login = getQQLoginState(input)
  if (!login) {
    return { synced: false, skipped: true, reason: 'QQ Music login cookie is not configured' }
  }
  if (!input.playUrl) {
    return { synced: false, skipped: true, reason: 'QQ play history sync requires an upstream play URL' }
  }

  try {
    const raw = await reportQQSdkPlay({
      login,
      musicInfo: input.musicInfo,
      playUrl: input.playUrl,
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
  quality: MusicQuality
  playUrl?: string
}): void {
  void syncQQPlayHistory(input).then((result) => {
    if (!result.synced) {
      const detail = result.skipped ? result.reason : result.error
      console.warn(`QQ play history sync skipped/failed for ${input.musicInfo.songmid}: ${detail}`)
    }
  }).catch((error: unknown) => {
    console.warn(
      `QQ play history sync crashed for ${input.musicInfo.songmid}: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
}
