import type { PagedResult, QQToplistInfo } from '@/lib/types'
import { compactSongs, type QQSong } from './mapper'
import { qqGet, qqPost, QQMusicError } from './http'

const DEFAULT_LIMIT = 100

const FALLBACK_TOPLISTS: QQToplistInfo[] = [
  { source: 'tx', id: 'tx__4', name: '流行指数榜', bangid: '4' },
  { source: 'tx', id: 'tx__26', name: '热歌榜', bangid: '26' },
  { source: 'tx', id: 'tx__27', name: '新歌榜', bangid: '27' },
  { source: 'tx', id: 'tx__62', name: '飙升榜', bangid: '62' },
  { source: 'tx', id: 'tx__58', name: '说唱榜', bangid: '58' },
  { source: 'tx', id: 'tx__57', name: '喜力电音榜', bangid: '57' },
  { source: 'tx', id: 'tx__28', name: '网络歌曲榜', bangid: '28' },
  { source: 'tx', id: 'tx__5', name: '内地榜', bangid: '5' },
  { source: 'tx', id: 'tx__3', name: '欧美榜', bangid: '3' },
  { source: 'tx', id: 'tx__59', name: '香港地区榜', bangid: '59' },
  { source: 'tx', id: 'tx__16', name: '韩国榜', bangid: '16' },
  { source: 'tx', id: 'tx__60', name: '抖快榜', bangid: '60' },
  { source: 'tx', id: 'tx__29', name: '影视金曲榜', bangid: '29' },
  { source: 'tx', id: 'tx__17', name: '日本榜', bangid: '17' },
  { source: 'tx', id: 'tx__52', name: '腾讯音乐人原创榜', bangid: '52' },
  { source: 'tx', id: 'tx__36', name: 'K歌金曲榜', bangid: '36' },
  { source: 'tx', id: 'tx__61', name: '台湾地区榜', bangid: '61' },
  { source: 'tx', id: 'tx__63', name: 'DJ舞曲榜', bangid: '63' },
  { source: 'tx', id: 'tx__64', name: '综艺新歌榜', bangid: '64' },
  { source: 'tx', id: 'tx__65', name: '国风热歌榜', bangid: '65' },
  { source: 'tx', id: 'tx__67', name: '听歌识曲榜', bangid: '67' },
  { source: 'tx', id: 'tx__72', name: '动漫音乐榜', bangid: '72' },
  { source: 'tx', id: 'tx__73', name: '游戏音乐榜', bangid: '73' },
  { source: 'tx', id: 'tx__75', name: '有声榜', bangid: '75' },
  { source: 'tx', id: 'tx__131', name: '校园音乐人排行榜', bangid: '131' },
]

type QQToplistResponse = {
  code: number
  data?: {
    topList?: Array<{
      id: number
      topTitle: string
    }>
  }
}

type QQToplistDetailResponse = {
  code: number
  toplist?: {
    code?: number
    data?: {
      songInfoList?: QQSong[]
      totalNum?: number
    }
  }
}

function normalizeToplistId(id: string) {
  return id.replace(/^tx__/, '')
}

function mapRemoteToplists(data: QQToplistResponse): QQToplistInfo[] {
  const rawList = data.data?.topList
  if (!rawList?.length) return FALLBACK_TOPLISTS

  return rawList
    .filter((item) => item.id !== 201)
    .map((item) => {
      let name = item.topTitle
      if (name.startsWith('巅峰榜·')) name = name.slice(4)
      if (!name.endsWith('榜')) name += '榜'
      return {
        source: 'tx' as const,
        id: `tx__${item.id}`,
        name,
        bangid: String(item.id),
      }
    })
}

export async function getQQToplists(): Promise<{ source: 'tx'; list: QQToplistInfo[] }> {
  try {
    const data = await qqGet<QQToplistResponse>(
      'https://c.y.qq.com/v8/fcg-bin/fcg_myqq_toplist.fcg?g_tk=1928093487&inCharset=utf-8&outCharset=utf-8&notice=0&format=json&uin=0&needNewCode=1&platform=h5',
    )
    if (data.code !== 0) return { source: 'tx', list: FALLBACK_TOPLISTS }
    return { source: 'tx', list: mapRemoteToplists(data) }
  } catch {
    return { source: 'tx', list: FALLBACK_TOPLISTS }
  }
}

export async function getQQToplistDetail(
  id: string,
  page = 1,
  limit = DEFAULT_LIMIT,
): Promise<PagedResult<ReturnType<typeof compactSongs>[number]>> {
  const topid = Number.parseInt(normalizeToplistId(id), 10)
  if (!Number.isFinite(topid)) throw new QQMusicError('Invalid QQ toplist id')

  const data = await qqPost<QQToplistDetailResponse>('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    toplist: {
      module: 'musicToplist.ToplistInfoServer',
      method: 'GetDetail',
      param: {
        topid,
        num: limit,
        offset: Math.max(page - 1, 0) * limit,
      },
    },
    comm: {
      uin: 0,
      format: 'json',
      ct: 20,
      cv: 1859,
    },
  })

  if (data.code !== 0 || data.toplist?.code !== 0) {
    throw new QQMusicError('QQ toplist detail request failed', undefined, data)
  }

  const rawList = data.toplist.data?.songInfoList ?? []
  const list = compactSongs(rawList)
  const total = data.toplist.data?.totalNum ?? list.length
  return {
    source: 'tx',
    list,
    page,
    limit,
    total,
    allPage: Math.ceil(total / limit),
  }
}

export { FALLBACK_TOPLISTS as QQ_FALLBACK_TOPLISTS }
