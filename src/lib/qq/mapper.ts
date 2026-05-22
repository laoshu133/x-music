import type { MusicInfo, MusicQuality, QQPlaylistInfo } from '@/lib/types'
import { decodeHtml, formatDate, formatDuration, formatPlayCount, formatSize } from './format'

type QQSinger = {
  name?: string
  mid?: string
}

type QQAlbum = {
  name?: string
  mid?: string
  time_public?: string
}

type QQFile = {
  media_mid?: string
  size_128mp3?: number
  size_320mp3?: number
  size_flac?: number
  size_hires?: number
}

export type QQSong = {
  id?: number
  mid?: string
  title?: string
  name?: string
  interval?: number
  time_public?: string
  year?: string | number
  favoriteTime?: string | number
  favTime?: string | number
  fav_time?: string | number
  addTime?: string | number
  add_time?: string | number
  modifyTime?: string | number
  modify_time?: string | number
  ctime?: string | number
  createTime?: string | number
  create_time?: string | number
  singer?: QQSinger[]
  album?: QQAlbum
  file?: QQFile
}

function formatSingers(singers?: QQSinger[]) {
  return singers
    ?.map((singer) => singer.name)
    .filter((name): name is string => Boolean(name))
    .join('、') ?? ''
}

function mapQuality(type: MusicQuality | 'flac24bit', size?: number) {
  return {
    type,
    size: formatSize(size),
  }
}

function mapTypes(file?: QQFile) {
  const types: MusicInfo['types'] = []
  if (!file) return types
  if (file.size_128mp3) types.push(mapQuality('128k', file.size_128mp3))
  if (file.size_320mp3) types.push(mapQuality('320k', file.size_320mp3))
  if (file.size_flac) types.push(mapQuality('flac', file.size_flac))
  if (file.size_hires) types.push(mapQuality('flac24bit', file.size_hires))
  return types
}

export function mapQQSong(item: QQSong): MusicInfo | null {
  const songmid = item.mid
  if (!songmid) return null
  const mediaMid = item.file?.media_mid ?? songmid

  const albumId = item.album?.mid ?? ''
  const firstSingerMid = item.singer?.[0]?.mid
  const img = albumId
    ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumId}.jpg`
    : firstSingerMid
      ? `https://y.gtimg.cn/music/photo_new/T001R500x500M000${firstSingerMid}.jpg`
      : ''

  return {
    source: 'tx',
    songmid,
    name: item.title ?? item.name ?? '',
    singer: formatSingers(item.singer),
    albumName: item.album?.name ?? '',
    albumId,
    interval: formatDuration(item.interval),
    img,
    types: mapTypes(item.file),
    raw: {
      songId: item.id,
      strMediaMid: mediaMid,
      albumMid: albumId,
      songmid,
      favoriteTime: item.favoriteTime,
      favTime: item.favTime,
      fav_time: item.fav_time,
      addTime: item.addTime,
      add_time: item.add_time,
      modifyTime: item.modifyTime,
      modify_time: item.modify_time,
      ctime: item.ctime,
      createTime: item.createTime,
      create_time: item.create_time,
      time_public: item.time_public,
      year: item.year,
      album: {
        time_public: item.album?.time_public,
      },
    },
  }
}

type QQPlaylistSearchItem = {
  dissid?: string | number
  dissname?: string
  creator?: { name?: string }
  imgurl?: string
  introduction?: string
  song_count?: number
  listennum?: number
  createtime?: number | string
}

export function mapQQPlaylistSearchItem(item: QQPlaylistSearchItem): QQPlaylistInfo {
  return {
    source: 'tx',
    id: String(item.dissid ?? ''),
    name: decodeHtml(item.dissname),
    author: decodeHtml(item.creator?.name),
    img: item.imgurl,
    desc: decodeHtml(decodeHtml(item.introduction)),
    total: item.song_count,
    playCount: formatPlayCount(item.listennum),
    time: formatDate(item.createtime),
  }
}

type QQPlaylistDetailRaw = {
  disstid?: string | number
  dissname?: string
  logo?: string
  desc?: string
  nickname?: string
  visitnum?: number
}

export function mapQQPlaylistDetailInfo(item: QQPlaylistDetailRaw): QQPlaylistInfo {
  return {
    source: 'tx',
    id: String(item.disstid ?? ''),
    name: decodeHtml(item.dissname),
    author: decodeHtml(item.nickname),
    img: item.logo,
    desc: decodeHtml(item.desc),
    playCount: formatPlayCount(item.visitnum),
  }
}

export function compactSongs(items: QQSong[]) {
  return items.map(mapQQSong).filter((item): item is MusicInfo => Boolean(item))
}
