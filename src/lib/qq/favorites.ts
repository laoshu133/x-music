import type { MusicInfo, PagedResult } from '@/lib/types'
import { compactSongs, type QQSong } from './mapper'
import { QQMusicError, qqPost, qqSignedPost } from './http'
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
  req?: {
    code?: number
    msg?: string
    message?: string
    data?: unknown
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

function buildFavoriteMutationPayload(login: QQLoginState, songmid: string, favorited: boolean) {
  return {
    comm: {
      cv: 4747474,
      ct: 24,
      format: 'json',
      uin: login.uin,
      g_tk: 5381,
    },
    req: {
      module: 'music.musicasset.SongFavWrite',
      method: favorited ? 'AddSongFan' : 'DelSongFan',
      param: {
        uin: login.uin,
        songMids: [songmid],
      },
    },
  }
}

function assertRemoteSuccess(data: QQFavoriteMutationResponse, action: string) {
  if (data.code === 0 && (data.req?.code === 0 || data.req?.code === undefined)) return

  throw new QQMusicError(`QQ favorite ${action} request was rejected`, 502, {
    actionable: 'The QQ Music favorite write endpoint is private and may have changed. Recheck the module/method with a real authenticated request.',
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
}): Promise<FavoriteMutationResult> {
  const login = requireQQLoginState(input)
  const data = await qqPost<QQFavoriteMutationResponse>(
    'https://u.y.qq.com/cgi-bin/musicu.fcg',
    buildFavoriteMutationPayload(login, input.songmid, input.favorited),
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
