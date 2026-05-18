import type { MusicInfo, PagedResult, QQPlaylistInfo } from '@/lib/types'
import { compactSongs, mapQQPlaylistSearchItem, type QQSong } from './mapper'
import { qqGet, QQMusicError, qqSignedPost } from './http'

type QQSearchResponse = {
  code: number
  req?: {
    code: number
    data?: {
      body?: {
        item_song?: QQSong[]
      }
      meta?: {
        estimate_sum?: number
      }
    }
  }
}

type QQPlaylistSearchResponse = {
  code: number
  data?: {
    list?: Parameters<typeof mapQQPlaylistSearchItem>[0][]
    sum?: number
  }
}

function buildSearchPayload(query: string, page: number, limit: number) {
  return {
    comm: {
      ct: '11',
      cv: '14090508',
      v: '14090508',
      tmeAppID: 'qqmusic',
      phonetype: 'EBG-AN10',
      deviceScore: '553.47',
      devicelevel: '50',
      newdevicelevel: '20',
      rom: 'HuaWei/EMOTION/EmotionUI_14.2.0',
      os_ver: '12',
      OpenUDID: '0',
      OpenUDID2: '0',
      QIMEI36: '0',
      udid: '0',
      chid: '0',
      aid: '0',
      oaid: '0',
      taid: '0',
      tid: '0',
      wid: '0',
      uid: '0',
      sid: '0',
      modeSwitch: '6',
      teenMode: '0',
      ui_mode: '2',
      nettype: '1020',
      v4ip: '',
    },
    req: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicMobile',
      param: {
        search_type: 0,
        searchid: Math.random().toString().slice(2),
        query,
        page_num: page,
        num_per_page: limit,
        highlight: 0,
        nqc_flag: 0,
        multi_zhida: 0,
        cat: 2,
        grp: 1,
        sin: 0,
        sem: 0,
      },
    },
  }
}

export async function searchQQMusic(
  query: string,
  page = 1,
  limit = 30,
): Promise<PagedResult<MusicInfo>> {
  const data = await qqSignedPost<QQSearchResponse>(buildSearchPayload(query, page, limit))
  if (data.code !== 0 || data.req?.code !== 0) {
    throw new QQMusicError('QQ song search failed', undefined, data)
  }

  const body = data.req.data?.body
  const meta = data.req.data?.meta
  const list = compactSongs(body?.item_song ?? [])
  const total = meta?.estimate_sum ?? list.length
  return {
    source: 'tx',
    list,
    page,
    limit,
    total,
    allPage: Math.ceil(total / limit),
  }
}

export async function searchQQPlaylists(
  query: string,
  page = 1,
  limit = 20,
): Promise<PagedResult<QQPlaylistInfo>> {
  const params = new URLSearchParams({
    page_no: String(Math.max(page - 1, 0)),
    num_per_page: String(limit),
    format: 'json',
    query,
    remoteplace: 'txt.yqq.playlist',
    inCharset: 'utf8',
    outCharset: 'utf-8',
  })
  const data = await qqGet<QQPlaylistSearchResponse>(
    `https://c.y.qq.com/soso/fcgi-bin/client_music_search_songlist?${params}`,
    {
      headers: {
        referer: 'https://y.qq.com/portal/search.html',
      },
    },
  )
  if (data.code !== 0) throw new QQMusicError('QQ playlist search failed', undefined, data)

  const list = (data.data?.list ?? []).map(mapQQPlaylistSearchItem).filter((item) => item.id)
  const total = data.data?.sum ?? list.length
  return {
    source: 'tx',
    list,
    page,
    limit,
    total,
    allPage: Math.ceil(total / limit),
  }
}
