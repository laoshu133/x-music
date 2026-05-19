import type { MusicInfo, MusicQuality } from '@/lib/types'
import { getQQLoginState, type QQLoginState } from './account'
import { QQMusicError, qqPost } from './http'

const PLAY_REPORT_URL = 'https://stat6.y.qq.com/pc/fcgi-bin/cgi_music_webreport.fcg'
const PLAYER_REFERER = 'https://y.qq.com/portal/player.html'

type QQSongDetailResponse = {
  get_song_detail?: {
    code?: number
    data?: {
      track_info?: {
        id?: number
        type?: number
      }
    }
  }
}

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
  return input.songId ?? fromRaw ?? Number.NaN
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

function parseIntervalSeconds(interval?: string): number | undefined {
  if (!interval) return undefined
  if (/^\d+$/.test(interval)) return Number(interval)

  const parts = interval.split(':').map(part => Number(part))
  if (!parts.length || parts.some(part => !Number.isFinite(part) || part < 0)) return undefined

  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return undefined
}

function playTimeSeconds(musicInfo: MusicInfo): number {
  const parsed = parseIntervalSeconds(musicInfo.interval)
  if (parsed && parsed > 0) return Math.floor(parsed)
  return 30
}

function reportType(songType: number): number {
  return songType === 0 ? 3 : 1
}

function buildGuid() {
  return `${Date.now()}${Math.floor(100000000 + Math.random() * 900000000)}`
}

function buildPlayReportUrl(input: {
  login: QQLoginState
  songId: number
  songType: number
  musicInfo: MusicInfo
}) {
  const startTime = Math.floor(Date.now() / 1000)
  const params = new URLSearchParams({
    Count: '1',
    Fqq: input.login.uin,
    Fguid: buildGuid(),
    Ffromtag1: '10050',
    Ffromtag2: String(input.songId),
    Fsong_id: String(input.songId),
    Fplay_time: String(playTimeSeconds(input.musicInfo)),
    Fstart_time: String(startTime),
    Ftype: String(reportType(input.songType)),
    Fversion: '1',
    Fid1: '0',
  })
  return `${PLAY_REPORT_URL}?${params.toString()}`
}

async function resolveSongInfoByMid(songmid: string, login: QQLoginState): Promise<PlayHistorySongInfo | undefined> {
  const data = await qqPost<QQSongDetailResponse>(
    'https://u.y.qq.com/cgi-bin/musicu.fcg',
    {
      get_song_detail: {
        module: 'music.pf_song_detail_svr',
        method: 'get_song_detail',
        param: { song_id: 0, song_mid: songmid, song_type: 0 },
      },
      comm: {
        g_tk: 0,
        uin: login.uin,
        format: 'json',
        ct: 6,
        cv: 80600,
        platform: 'wk_v17',
        uid: login.uin,
        guid: buildGuid(),
      },
    },
    {
      headers: {
        cookie: login.cookie,
        referer: 'https://y.qq.com/',
      },
    },
  )

  const track = data.get_song_detail?.data?.track_info
  if (!track?.id) return undefined
  return { songId: track.id, songType: track.type ?? 0, raw: track }
}

async function resolvePlayHistorySongInfo(musicInfo: MusicInfo, login: QQLoginState): Promise<Required<Pick<PlayHistorySongInfo, 'songId' | 'songType'>>> {
  const local = {
    raw: musicInfo.raw,
    songId: resolveSongId({ raw: musicInfo.raw }),
    songType: resolveSongType({ raw: musicInfo.raw }),
  }
  if (Number.isFinite(local.songId)) {
    return { songId: local.songId, songType: local.songType }
  }

  const remote = await resolveSongInfoByMid(musicInfo.songmid, login)
  const remoteSongId = resolveSongId(remote ?? {})
  if (Number.isFinite(remoteSongId)) {
    return { songId: remoteSongId, songType: resolveSongType(remote ?? {}) }
  }

  throw new QQMusicError('QQ play history sync requires numeric songId', 400, {
    actionable: 'QQ song detail did not return a numeric song id for this songmid.',
    songmid: musicInfo.songmid,
    raw: musicInfo.raw,
  })
}

async function reportQQPlay(input: {
  login: QQLoginState
  musicInfo: MusicInfo
  songId: number
  songType: number
}) {
  const url = buildPlayReportUrl(input)
  const response = await fetch(url, {
    headers: {
      accept: '*/*',
      cookie: input.login.cookie,
      referer: PLAYER_REFERER,
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
    },
    cache: 'no-store',
  })
  const body = await response.text().catch(() => '')
  if (!response.ok) {
    throw new QQMusicError('QQ play history report request failed', response.status, {
      body: body.slice(0, 500),
    })
  }

  return {
    status: response.status,
    body: body.slice(0, 500),
    songId: input.songId,
    songType: input.songType,
  }
}

export async function syncQQPlayHistory(input: {
  cookie?: string
  musicInfo: MusicInfo
  quality: MusicQuality
}): Promise<QQPlayHistorySyncResult> {
  const login = getQQLoginState(input)
  if (!login) {
    return { synced: false, skipped: true, reason: 'QQ Music login cookie is not configured' }
  }

  try {
    const songInfo = await resolvePlayHistorySongInfo(input.musicInfo, login)
    const raw = await reportQQPlay({
      login,
      musicInfo: input.musicInfo,
      songId: songInfo.songId,
      songType: songInfo.songType,
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
