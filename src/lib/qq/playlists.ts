import type { QQPlaylistDetail } from '@/lib/types'
import { decodeHtml } from './format'
import { qqGet, QQMusicError } from './http'
import { compactSongs, mapQQPlaylistDetailInfo, type QQSong } from './mapper'

type QQPlaylistDetailResponse = {
  code: number
  cdlist?: Array<{
    disstid?: string | number
    dissname?: string
    logo?: string
    desc?: string
    nickname?: string
    visitnum?: number
    songlist?: QQSong[]
  }>
}

function parsePlaylistId(idOrUrl: string) {
  if (/^\d+$/.test(idOrUrl)) return idOrUrl
  const playlistMatch = idOrUrl.match(/\/playlist\/(\d+)/)
  if (playlistMatch?.[1]) return playlistMatch[1]
  const queryMatch = idOrUrl.match(/[?&]id=(\d+)/)
  if (queryMatch?.[1]) return queryMatch[1]
  throw new QQMusicError('Invalid QQ playlist id')
}

export async function getQQPlaylistDetail(idOrUrl: string): Promise<QQPlaylistDetail> {
  const id = parsePlaylistId(idOrUrl)
  const params = new URLSearchParams({
    type: '1',
    json: '1',
    utf8: '1',
    onlysong: '0',
    new_format: '1',
    disstid: id,
    loginUin: '0',
    hostUin: '0',
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: '0',
    platform: 'yqq.json',
    needNewCode: '0',
  })
  const data = await qqGet<QQPlaylistDetailResponse>(
    `https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?${params}`,
    {
      headers: {
        referer: `https://y.qq.com/n/yqq/playsquare/${id}.html`,
      },
    },
  )
  if (data.code !== 0 || !data.cdlist?.[0]) {
    throw new QQMusicError('QQ playlist detail request failed', undefined, data)
  }

  const cd = data.cdlist[0]
  const list = compactSongs(cd.songlist ?? [])
  const info = {
    ...mapQQPlaylistDetailInfo(cd),
    id,
    desc: decodeHtml(cd.desc),
    total: list.length,
  }

  return {
    source: 'tx',
    info,
    list,
    page: 1,
    limit: list.length,
    total: list.length,
  }
}
