import type { MusicInfo } from '@/lib/types'
import { compactSongs, type QQSong } from './mapper'
import { requireQQLoginState } from './account'
import { QQMusicError, qqSignedPost } from './http'

type QQRecommendationsResponse = {
  code: number
  req?: {
    code: number
    data?: {
      Tracks?: QQSong[]
      songlist?: QQSong[]
      v_song?: QQSong[]
      list?: Array<QQSong | { songInfo?: QQSong; songinfo?: QQSong }>
    }
  }
}

function buildRecommendationsPayload(uin: string, limit: number) {
  return {
    comm: {
      cv: 4747474,
      ct: 24,
      format: 'json',
      uin,
      g_tk: 5381,
    },
    req: {
      module: 'music.radioProxy.MbTrackRadioSvr',
      method: 'get_radio_track',
      param: {
        id: 99,
        num: limit,
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
} = {}): Promise<{ source: 'tx'; list: MusicInfo[]; experimental: true }> {
  const login = requireQQLoginState(input)
  const limit = input.limit ?? 30

  const data = await qqSignedPost<QQRecommendationsResponse>(
    buildRecommendationsPayload(login.uin, limit),
    {
      headers: {
        cookie: login.cookie,
        referer: 'https://y.qq.com/n/ryqq/',
      },
    },
  )

  if (data.code !== 0 || data.req?.code !== 0) {
    throw new QQMusicError('QQ recommendations request failed', 502, {
      actionable: 'The QQ Music recommendation endpoint is private and experimental. Recheck RecommendFeedServer with a real authenticated request.',
      response: data,
    })
  }

  return {
    source: 'tx',
    list: compactSongs(extractSongs(data)).slice(0, limit),
    experimental: true,
  }
}
