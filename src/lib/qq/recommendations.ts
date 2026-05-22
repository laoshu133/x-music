import type { MusicInfo, PagedResult } from '@/lib/types'
import { compactSongs, type QQSong } from './mapper'
import { getQQLoginState } from './account'
import { QQMusicError, qqSignedPost } from './http'
import { getQQFavoriteSongs } from './favorites'
import { getQQToplistDetail } from './toplists'
import { getQQPlaylistDetail } from './playlists'
import { searchQQPlaylists } from './search'

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

export type RecommendationResult = PagedResult<MusicInfo> & {
  strategy: string
  personalized: boolean
}

const DAILY_30_QUERIES = ['daily 30', '每日30', '每日推荐30', 'QQ音乐每日30首']

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
} = {}): Promise<RecommendationResult> {
  const login = getQQLoginState(input)
  const limit = input.limit ?? 30
  if (!login) return fallbackRecommendations(limit, 'toplist-hot')

  try {
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
        actionable: 'The QQ Music recommendation endpoint is private and experimental. Recheck MbTrackRadioSvr with a real authenticated request.',
        response: data,
      })
    }

    const list = compactSongs(extractSongs(data)).slice(0, limit)
    if (list.length) return paged(list, limit, 'qq-radio', true)
  } catch {
    // Private endpoints change frequently. Keep the feature usable through stable QQ data below.
  }

  return favoriteSeededFallback({ cookie: login.cookie, limit })
}

export async function getQQDailyRecommendations(input: {
  limit?: number
} = {}): Promise<RecommendationResult> {
  const limit = input.limit ?? 30

  for (const query of DAILY_30_QUERIES) {
    const found = await searchQQPlaylists(query, 1, 10).catch(() => undefined)
    const playlist = found?.list.find(isDaily30Playlist) ?? found?.list[0]
    if (!playlist?.id) continue

    const detail = await getQQPlaylistDetail(playlist.id).catch(() => undefined)
    const list = detail?.list.slice(0, limit) ?? []
    if (list.length) return paged(list, limit, `qq-playlist:${playlist.id}`, true)
  }

  return fallbackRecommendations(limit, 'toplist-daily-fallback')
}

async function favoriteSeededFallback(input: { cookie?: string; limit: number }): Promise<RecommendationResult> {
  try {
    const favorites = await getQQFavoriteSongs({ cookie: input.cookie, limit: 12 })
    const seed = favorites.list.find(song => song.singer)
    if (seed) {
      const { searchQQMusic } = await import('./search')
      const related = await searchQQMusic(seed.singer, 1, input.limit + favorites.list.length)
      const favoriteKeys = new Set(favorites.list.map(song => song.songmid))
      const list = related.list.filter(song => !favoriteKeys.has(song.songmid)).slice(0, input.limit)
      if (list.length) return paged(list, input.limit, 'favorite-artist-search', true)
    }
  } catch {
    // Fall through to public toplist.
  }

  return fallbackRecommendations(input.limit, 'toplist-hot')
}

async function fallbackRecommendations(limit: number, strategy: string): Promise<RecommendationResult> {
  const result = await getQQToplistDetail('62', 1, limit).catch(() => getQQToplistDetail('26', 1, limit))
  return paged(result.list.slice(0, limit), limit, strategy, false)
}

function isDaily30Playlist(playlist: { name?: string; desc?: string }): boolean {
  const text = `${playlist.name ?? ''} ${playlist.desc ?? ''}`.toLowerCase()
  return (text.includes('daily') && text.includes('30')) || text.includes('每日30') || text.includes('每日 30')
}

function paged(list: MusicInfo[], limit: number, strategy: string, personalized: boolean): RecommendationResult {
  return {
    source: 'tx',
    list,
    page: 1,
    limit,
    total: list.length,
    allPage: 1,
    strategy,
    personalized,
  }
}
