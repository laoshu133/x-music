import type { MusicInfo } from '@/lib/types'
import { compactSongs, type QQSong } from './mapper'
import { qqPost, QQMusicError } from './http'

type QQSongDetailResponse = {
  code: number
  songinfo?: {
    code?: number
    data?: {
      track_info?: QQSong
    }
  }
}

export async function getQQSongDetail(songmid: string): Promise<MusicInfo> {
  const data = await qqPost<QQSongDetailResponse>('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    comm: {
      ct: 24,
      cv: 0,
    },
    songinfo: {
      method: 'get_song_detail_yqq',
      module: 'music.pf_song_detail_svr',
      param: {
        song_mid: songmid,
      },
    },
  })

  if (data.code !== 0 || data.songinfo?.code !== 0 || !data.songinfo.data?.track_info) {
    throw new QQMusicError('QQ song detail request failed', undefined, data)
  }

  const song = compactSongs([data.songinfo.data.track_info])[0]
  if (!song) throw new QQMusicError('QQ song detail response did not include playable song metadata', undefined, data)
  return song
}
