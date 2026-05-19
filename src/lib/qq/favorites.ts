import type { MusicInfo, PagedResult } from '@/lib/types'
import { compactSongs, type QQSong } from './mapper'
import { QQMusicError, qqSignedPost } from './http'
import { requireQQLoginState, type QQLoginState } from './account'

type QQFavoriteListResponse = {
  code: number
  req?: {
    code: number
    data?: {
      songlist?: QQSong[]
      total_song_num?: number
      total?: number
      hasmore?: number
    }
  }
}

type QQFavoriteMutationResponse = {
  code: number
  req?: QQFavoriteMutationItem
}

type QQFavoriteMutationItem = {
  code?: number
  msg?: string
  message?: string
  data?: {
    result?: number
    ret?: number
    [key: string]: unknown
  } | unknown
  subcode?: number
  subCode?: number
  trace?: string
  [key: string]: unknown
}

type FavoriteSongInfo = {
  songId?: number
  songType?: number
  raw?: unknown
}

type FavoriteMutationPayload = {
  comm: Record<string, unknown>
  req: {
    module: string
    method: string
    param: Record<string, unknown>
  }
}

export type FavoriteMutationResult = {
  source: 'tx'
  songmid: string
  favorited: boolean
  synced: boolean
  message?: string
  raw?: unknown
}

function buildFavoriteListPayload(login: QQLoginState, page: number, limit: number) {
  if (!login.encryptedUin) {
    throw new QQMusicError('QQ encrypted UIN is required to read favorite songs', 401, {
      actionable: 'Provide a cookie text that includes euin/encryptUin, or capture the CgiGetDiss favorite-song request from y.qq.com and add its enc_host_uin value.',
    })
  }

  return {
    comm: {
      cv: 4747474,
      ct: 24,
      format: 'json',
      uin: login.uin,
      g_tk: 5381,
    },
    req: {
      module: 'music.srfDissInfo.DissInfo',
      method: 'CgiGetDiss',
      param: {
        disstid: 0,
        dirid: 201,
        tag: true,
        song_begin: Math.max(page - 1, 0) * limit,
        song_num: limit,
        userinfo: true,
        orderlist: true,
        enc_host_uin: login.encryptedUin,
      },
    },
  }
}

function buildFavoriteMutationPayload(
  login: QQLoginState,
  songmid: string,
  favorited: boolean,
  songInfo: FavoriteSongInfo = {},
): FavoriteMutationPayload {
  const songId = resolveSongId(songInfo)
  if (!Number.isFinite(songId)) {
    throw new QQMusicError('QQ favorite sync requires numeric songId', 400, {
      actionable: 'Refresh the song from QQ Music search/playlist data so raw.songId is available before syncing favorites.',
      songmid,
      raw: songInfo.raw,
    })
  }

  return {
    comm: {
      cv: 4747474,
      ct: 24,
      format: 'json',
      uin: login.uin,
      g_tk: 5381,
    },
    req: {
      module: 'music.musicasset.PlaylistDetailWrite',
      method: favorited ? 'AddSonglist' : 'DelSonglist',
      param: {
        dirId: 201,
        v_songInfo: [{
          songId,
          songType: resolveSongType(songInfo),
        }],
      },
    },
  }
}

function resolveSongId(input: FavoriteSongInfo): number {
  const fromRaw = readRawNumber(input.raw, ['songId', 'songid', 'song_id', 'id'])
  return input.songId ?? fromRaw ?? Number.NaN
}

function resolveSongType(input: FavoriteSongInfo): number {
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

function mutationSucceeded(item: QQFavoriteMutationItem | undefined): boolean {
  if (!item) return false
  if (item.code !== 0 && item.code !== undefined) return false
  const data = item.data
  if (!data || typeof data !== 'object') return true
  const resultCode = (data as { result?: unknown; ret?: unknown; retCode?: unknown }).retCode
    ?? (data as { ret?: unknown }).ret
  return resultCode === undefined || resultCode === 0
}

function assertRemoteSuccess(data: QQFavoriteMutationResponse, action: string) {
  if (data.code === 0 && mutationSucceeded(data.req)) return

  throw new QQMusicError(`QQ favorite ${action} request was rejected`, 502, {
    actionable: 'QQ Music rejected the favorite write request. Recheck login state and the private PlaylistDetailWrite payload against a real authenticated y.qq.com request.',
    response: data,
  })
}

export async function getQQFavoriteSongs(input: {
  cookie?: string
  page?: number
  limit?: number
} = {}): Promise<PagedResult<MusicInfo>> {
  const login = requireQQLoginState(input)
  const page = input.page ?? 1
  const limit = input.limit ?? 50

  const data = await qqSignedPost<QQFavoriteListResponse>(buildFavoriteListPayload(login, page, limit), {
    headers: {
      cookie: login.cookie,
      referer: 'https://y.qq.com/n/ryqq/profile/like/song',
    },
  })

  if (data.code !== 0 || data.req?.code !== 0) {
    throw new QQMusicError('QQ favorite songs request failed', 502, {
      actionable: 'Verify QQ_MUSIC_COOKIE is current and confirm the private favorite read endpoint still accepts CgiGetDiss with enc_host_uin.',
      response: data,
    })
  }

  const list = compactSongs(data.req.data?.songlist ?? [])
  const total = data.req.data?.total_song_num ?? data.req.data?.total ?? list.length
  return {
    source: 'tx',
    list,
    page,
    limit,
    total,
    allPage: Math.ceil(total / limit),
  }
}

export async function setQQFavoriteSong(input: {
  cookie?: string
  songmid: string
  favorited: boolean
  songId?: number
  songType?: number
  raw?: unknown
}): Promise<FavoriteMutationResult> {
  const login = requireQQLoginState(input)
  const data = await qqSignedPost<QQFavoriteMutationResponse>(
    buildFavoriteMutationPayload(login, input.songmid, input.favorited, {
      songId: input.songId,
      songType: input.songType,
      raw: input.raw,
    }),
    {
      headers: {
        cookie: login.cookie,
        referer: 'https://y.qq.com/n/ryqq/profile/like/song',
      },
    },
  )
  assertRemoteSuccess(data, input.favorited ? 'add' : 'remove')

  return {
    source: 'tx',
    songmid: input.songmid,
    favorited: input.favorited,
    synced: true,
    raw: data.req?.data,
  }
}
