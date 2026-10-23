import type { MusicInfo, PagedResult } from '@/lib/types'
import { compactSongs, type QQSong } from './mapper'
import { QQMusicError, qqSignedEncryptedPost } from './http'
import { requireQQLoginState, type QQLoginState } from './account'
import { getQQSongDetail } from './song'
import { qqMusicGtk } from './crypto'

type QQFavoriteListResponse = {
  code: number
  req_0?: {
    code: number
    data?: {
      songlist?: QQSong[]
      total_song_num?: number
      total?: number
      hasmore?: number
    }
  }
  req?: QQFavoriteListResponse['req_0']
}

type QQFavoriteMutationResponse = {
  code: number
  req_0?: QQFavoriteMutationItem
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
  req_0: {
    module: string
    method: string
    param: Record<string, unknown>
  }
}

type QQFavoriteStateResponse = {
  code: number
  req_0?: {
    code?: number
    data?: {
      m_fan?: Record<string, unknown>
    }
  }
  req?: QQFavoriteStateResponse['req_0']
}

export type FavoriteMutationResult = {
  source: 'tx'
  songmid: string
  favorited: boolean
  synced: boolean
  verified?: boolean
  message?: string
  raw?: unknown
}

function buildQQFavoriteComm(login: QQLoginState) {
  if (!login.qqmusicKey) {
    throw new QQMusicError('QQ Music key is required for favorite requests', 401, {
      actionable: '重新完成 QQ 授权登录后再继续操作收藏。',
    })
  }
  const gtk = qqMusicGtk(login.qqmusicKey)
  return {
    cv: 4747474,
    ct: 24,
    format: 'json',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    notice: 0,
    platform: 'yqq.json',
    needNewCode: 1,
    uin: Number(login.uin),
    g_tk: gtk,
    g_tk_new_20200303: gtk,
  }
}

function buildFavoriteListPayload(login: QQLoginState, page: number, limit: number) {
  if (!login.encryptedUin) {
    throw new QQMusicError('QQ encrypted UIN is required to read favorite songs', 401, {
      actionable: 'Provide a cookie text that includes euin/encryptUin, or capture the CgiGetDiss favorite-song request from y.qq.com and add its enc_host_uin value.',
    })
  }

  return {
    comm: buildQQFavoriteComm(login),
    req_0: {
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
    comm: buildQQFavoriteComm(login),
    req_0: {
      module: 'music.musicasset.PlaylistDetailWrite',
      method: favorited ? 'AddSonglist' : 'DelSonglist',
      param: {
        dirId: 201,
        tid: 0,
        bFmtUtf8: true,
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
  const data = item.data
  if (!data || typeof data !== 'object') return true
  const record = data as { result?: unknown; ret?: unknown; retCode?: unknown }
  const resultCode = record.retCode ?? record.ret
  if (resultCode !== undefined && resultCode !== 0) return false
  if (item.code === 0 || item.code === undefined) return true
  return item.code === 80105 && resultCode === 0
}

function assertRemoteSuccess(data: QQFavoriteMutationResponse, action: string) {
  if (data.code === 0 && mutationSucceeded(data.req_0 ?? data.req)) return

  throw new QQMusicError(`QQ favorite ${action} request was rejected`, 502, {
    actionable: 'QQ 音乐拒绝了收藏写入，系统会在授权刷新后自动重试。',
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

  const data = await qqSignedEncryptedPost<QQFavoriteListResponse>(buildFavoriteListPayload(login, page, limit), {
    headers: {
      cookie: login.cookie,
      referer: 'https://y.qq.com/n/ryqq/profile/like/song',
    },
  })

  const item = data.req_0 ?? data.req
  if (data.code !== 0 || item?.code !== 0) {
    throw new QQMusicError('QQ favorite songs request failed', 502, {
      actionable: 'Refresh the current user QQ authorization and confirm the private favorite endpoint still accepts CgiGetDiss with enc_host_uin.',
      response: data,
    })
  }

  const list = compactSongs(item.data?.songlist ?? [])
  const total = item.data?.total_song_num ?? item.data?.total ?? list.length
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
  const songInfo: FavoriteSongInfo = {
    songId: input.songId,
    songType: input.songType,
    raw: input.raw,
  }
  if (!Number.isFinite(resolveSongId(songInfo))) {
    const detail = await getQQSongDetail(input.songmid)
    songInfo.raw = detail.raw
  }
  const data = await qqSignedEncryptedPost<QQFavoriteMutationResponse>(
    buildFavoriteMutationPayload(login, input.songmid, input.favorited, songInfo),
    {
      headers: {
        cookie: login.cookie,
        referer: 'https://y.qq.com/n/ryqq/profile/like/song',
      },
    },
  )
  assertRemoteSuccess(data, input.favorited ? 'add' : 'remove')
  const verified = await verifyFavoriteMutation({
    cookie: login.cookie,
    songmid: input.songmid,
    favorited: input.favorited,
  })

  return {
    source: 'tx',
    songmid: input.songmid,
    favorited: input.favorited,
    synced: true,
    verified,
    raw: data.req_0?.data,
  }
}

export async function isQQSongFavorited(input: {
  cookie?: string
  songmid: string
}): Promise<boolean | undefined> {
  const login = requireQQLoginState(input)
  const data = await qqSignedEncryptedPost<QQFavoriteStateResponse>({
    comm: buildQQFavoriteComm(login),
    req_0: {
      module: 'music.musicasset.SongFavRead',
      method: 'IsSongFanByMid',
      param: {
        v_songMid: [input.songmid],
      },
    },
  }, {
    headers: {
      cookie: login.cookie,
      referer: 'https://y.qq.com/n/ryqq/profile/like/song',
    },
  })
  const item = data.req_0 ?? data.req
  if (data.code !== 0 || item?.code !== 0) return undefined
  const value = item.data?.m_fan?.[input.songmid]
  if (typeof value === 'boolean') return value
  if (value === 0 || value === 1) return value === 1
  return undefined
}

async function verifyFavoriteMutation(input: {
  cookie: string
  songmid: string
  favorited: boolean
}): Promise<boolean | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await isQQSongFavorited(input).catch(() => undefined)
    if (state === input.favorited) return true
    if (state === undefined) return undefined
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new QQMusicError('QQ Music favorite state did not match the requested action', 502, {
    actionable: 'QQ 收藏写入未生效，系统会保留本地操作并自动重试。',
    songmid: input.songmid,
    expected: input.favorited,
  })
}
