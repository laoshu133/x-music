import fs from 'node:fs/promises'
import path from 'node:path'
import { parseFile } from 'music-metadata'
import type { IAudioMetadata, IPicture } from 'music-metadata'
import Metaflac from 'metaflac-js'
import NodeID3 from 'node-id3'
import { z } from 'zod'
import { appConfig } from '@/lib/config'
import type { TagTrackFileJobPayload } from '@/lib/tagging/types'

export type TaggingMode = 'builtin'

export interface TaggingResult {
  mode: TaggingMode
  finalPath: string
  lyricsPath?: string
  coverPath?: string
  warnings?: string[]
}

export interface TaggingProvider {
  tagFile(payload: TagTrackFileJobPayload): Promise<TaggingResult>
}

interface NormalizedMetadata {
  title?: string
  artist?: string
  artists?: string[]
  album?: string
  albumId?: string
  year?: string
  lyrics?: string
  cover?: CoverImage
}

interface CoverImage {
  data: Buffer
  mime: string
}

interface QQSearchSong {
  id?: number
  mid?: string
  name?: string
  title?: string
  time_public?: string
  singer?: Array<{ name?: string }>
  album?: { mid?: string; name?: string; title?: string; time_public?: string }
}

interface QQMusicApiSong {
  mid?: string
  name: string
  artist: string
  album: string
  albumId?: string
  year?: string
  albumImg?: string
}

interface MetaflacFile {
  pictures: Buffer[]
  picturesSpecs: unknown[]
  picturesDatas: Buffer[]
  removeTag(name: string): void
  setTag(field: string): void
  importPictureFromBuffer(picture: Buffer): void
  save(): void
}

const envBoolean = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false
  return value
}, z.boolean())

const supportedTagWriteExtensions = new Set(['.flac', '.mp3'])

const taggingEnv = z.object({
  TAGGING_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  TAGGING_WRITE_TAGS: envBoolean.default(true),
  TAGGING_FETCH_ONLINE_METADATA: envBoolean.default(true),
  TAGGING_ORGANIZE_FILES: envBoolean.default(true),
}).parse(process.env)

// Built-in tagging follows practical ideas from xhongc/music-tag-web:
// https://github.com/xhongc/music-tag-web

const normalizeToken = (value: string | undefined): string => (
  value ?? ''
).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

const firstValue = (...values: Array<string | undefined>): string | undefined => {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

function splitArtists(value?: string): string[] | undefined {
  const artists = value
    ?.split(/[、,，/;；]+/)
    .map((artist) => artist.trim())
    .filter(Boolean)
  return artists?.length ? artists : undefined
}

function matchScore(left: string | undefined, right: string | undefined): number {
  const leftToken = normalizeToken(left)
  const rightToken = normalizeToken(right)
  if (!leftToken || !rightToken) return 0
  if (leftToken === rightToken) return 2
  if (leftToken.includes(rightToken) || rightToken.includes(leftToken)) return 1
  return 0
}

function matchArtist(left: string | undefined, right: string | undefined): number {
  const rightArtists = splitArtists(right)
  if (!rightArtists?.length) return matchScore(left, right)
  return Math.max(...rightArtists.map((artist) => matchScore(left, artist)))
}

function scoreMetadataMatch(input: Pick<NormalizedMetadata, 'title' | 'artist' | 'album'>, candidate: QQMusicApiSong): number {
  let titleScore = matchScore(input.title, candidate.name)
  let artistScore = matchArtist(input.artist || input.title, candidate.artist)
  const albumScore = matchScore(input.album || input.title, candidate.album)

  if (input.artist && artistScore === 0) artistScore = -2
  if (!input.artist && artistScore >= 1 && titleScore >= 1) titleScore = 2

  return titleScore + artistScore + albumScore
}

function safePathSegment(value: string | undefined, fallback: string): string {
  const normalized = value
    ?.normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
  return normalized || fallback
}

function buildFinalPath(payload: TagTrackFileJobPayload, metadata: NormalizedMetadata): string {
  const ext = path.extname(payload.rawPath).toLowerCase() || '.mp3'
  const title = safePathSegment(metadata.title ?? payload.title, payload.songmid)
  const artist = safePathSegment(metadata.artist ?? payload.artist, 'Unknown Artist')
  const album = safePathSegment(metadata.album ?? payload.album, 'Unknown Album')
  const filename = `${artist} - ${title}${ext}`

  if (!taggingEnv.TAGGING_ORGANIZE_FILES) {
    return path.join(appConfig.musicDir, filename)
  }

  return path.join(appConfig.musicDir, artist, album, filename)
}

function buildSidecarPaths(finalPath: string, metadata: NormalizedMetadata): {
  lyricsPath?: string
  coverPath?: string
} {
  const parsed = path.parse(finalPath)
  return {
    lyricsPath: metadata.lyrics ? path.join(parsed.dir, `${parsed.name}.lrc`) : undefined,
    coverPath: metadata.cover ? path.join(parsed.dir, `cover${extensionFromMime(metadata.cover.mime)}`) : undefined,
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function copyRawToLibrary(rawPath: string, targetPath: string): Promise<string> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.copyFile(rawPath, targetPath)
  return targetPath
}

function extensionFromMime(mime: string): string {
  if (mime === 'image/png') return '.png'
  return '.jpg'
}

function mergePayloadMetadata(payload: TagTrackFileJobPayload, existing?: IAudioMetadata): NormalizedMetadata {
  const existingLyrics = existing?.common.lyrics?.map((lyric) => lyric.text).find(Boolean)
  const existingCover = existing?.common.picture?.[0]
  return {
    title: firstValue(payload.title, existing?.common.title, path.parse(payload.rawPath).name),
    artist: firstValue(payload.artist, existing?.common.artist),
    artists: splitArtists(firstValue(payload.artist, existing?.common.artist)),
    album: firstValue(payload.album, existing?.common.album),
    albumId: firstValue(payload.albumId),
    year: existing?.common.year ? String(existing.common.year) : undefined,
    lyrics: existingLyrics,
    cover: existingCover ? coverFromPicture(existingCover) : undefined,
  }
}

function coverFromPicture(picture: IPicture): CoverImage {
  return {
    data: Buffer.from(picture.data),
    mime: picture.format,
  }
}

function mergeOnlineMetadata(base: NormalizedMetadata, online?: NormalizedMetadata): NormalizedMetadata {
  if (!online) return base
  const artist = firstValue(online.artist, base.artist)
  return {
    title: firstValue(online.title, base.title),
    artist,
    artists: splitArtists(artist) ?? base.artists,
    album: firstValue(online.album, base.album),
    albumId: firstValue(online.albumId, base.albumId),
    year: firstValue(online.year, base.year),
    lyrics: firstValue(online.lyrics, base.lyrics),
    cover: online.cover ?? base.cover,
  }
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T | undefined> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(taggingEnv.TAGGING_FETCH_TIMEOUT_MS),
  })
  if (!response.ok) return undefined
  return await response.json() as T
}

function mapQQSong(song: QQSearchSong): QQMusicApiSong | undefined {
  const name = firstValue(song.title, song.name)
  if (!name) return undefined
  const artist = song.singer?.map((singer) => singer.name).filter((name): name is string => Boolean(name)).join(',') ?? ''
  const album = firstValue(song.album?.title, song.album?.name, 'Unknown Album') ?? 'Unknown Album'
  return {
    mid: song.mid,
    name,
    artist,
    album,
    albumId: song.album?.mid,
    year: firstValue(song.time_public, song.album?.time_public)?.slice(0, 4),
    albumImg: song.album?.mid ? `https://y.qq.com/music/photo_new/T002R500x500M000${song.album.mid}.jpg` : undefined,
  }
}

async function fetchQQSongDetail(songmid: string): Promise<QQMusicApiSong | undefined> {
  const data = await fetchJson<{
    get_song_detail?: { code?: number; data?: { track_info?: QQSearchSong } }
  }>('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: {
      'content-type': 'application/json;charset=utf-8',
      referer: 'https://y.qq.com/',
      'user-agent': 'Mozilla/5.0',
    },
    body: JSON.stringify({
      get_song_detail: {
        module: 'music.pf_song_detail_svr',
        method: 'get_song_detail',
        param: { song_id: 0, song_mid: songmid, song_type: 0 },
      },
      comm: {
        g_tk: 0,
        uin: '',
        format: 'json',
        ct: 6,
        cv: 80600,
        platform: 'wk_v17',
        uid: '',
        guid: crypto.randomUUID(),
      },
    }),
  }).catch(() => undefined)

  const song = data?.get_song_detail?.data?.track_info
  return song ? mapQQSong(song) : undefined
}

async function searchQQSongs(query: string): Promise<QQMusicApiSong[]> {
  const data = await fetchJson<{
    'music.search.SearchCgiService.DoSearchForQQMusicDesktop'?: {
      data?: { body?: { song?: { list?: QQSearchSong[] } } }
    }
  }>('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: {
      'content-type': 'application/json;charset=utf-8',
      referer: 'https://y.qq.com/portal/profile.html',
      'user-agent': 'QQMusic/73222 CFNetwork/1406.0.3 Darwin/22.4.0',
    },
    body: JSON.stringify({
      comm: {
        wid: '',
        tmeAppID: 'qqmusic',
        authst: '',
        uid: '',
        gray: '0',
        OpenUDID: '2d484d3157d4ed482e406e6c5fdcf8c3d3275deb',
        ct: '6',
        patch: '2',
        cv: '80600',
        gzip: '0',
        nettype: '2',
        tmeLoginType: '2',
      },
      'music.search.SearchCgiService.DoSearchForQQMusicDesktop': {
        module: 'music.search.SearchCgiService',
        method: 'DoSearchForQQMusicDesktop',
        param: {
          num_per_page: 10,
          page_num: 1,
          remoteplace: 'txt.mac.search',
          search_type: 0,
          query,
          grp: 1,
          searchid: crypto.randomUUID(),
          nqc_flag: 0,
        },
      },
    }),
  }).catch(() => undefined)

  const songs = data?.['music.search.SearchCgiService.DoSearchForQQMusicDesktop']?.data?.body?.song?.list ?? []
  return songs.map(mapQQSong).filter((song): song is QQMusicApiSong => Boolean(song))
}

async function fetchQQLyrics(songmid: string): Promise<string | undefined> {
  const data = await fetchJson<{ lyric?: string }>(
    `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?${new URLSearchParams({
      g_tk: '5381',
      format: 'json',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
      notice: '0',
      platform: 'h5',
      needNewCode: '1',
      ct: '121',
      cv: '0',
      songmid,
    })}`,
    {
      headers: {
        referer: 'https://y.qq.com/',
        'user-agent': 'Mozilla/5.0',
      },
    },
  ).catch(() => undefined)

  if (!data?.lyric) return undefined
  return normalizeLyrics(Buffer.from(data.lyric, 'base64').toString('utf8'))
}

function normalizeLyrics(value: string): string {
  return value.replace(/\r\n?/g, '\n').trimEnd()
}

async function fetchCover(url: string | undefined): Promise<CoverImage | undefined> {
  if (!url) return undefined
  const response = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(taggingEnv.TAGGING_FETCH_TIMEOUT_MS),
  }).catch(() => undefined)
  if (!response?.ok) return undefined
  const mime = response.headers.get('content-type')?.split(';', 1)[0] ?? 'image/jpeg'
  if (mime !== 'image/jpeg' && mime !== 'image/png') return undefined
  return {
    data: Buffer.from(await response.arrayBuffer()),
    mime,
  }
}

async function resolveOnlineMetadata(payload: TagTrackFileJobPayload, base: NormalizedMetadata): Promise<NormalizedMetadata | undefined> {
  if (!taggingEnv.TAGGING_FETCH_ONLINE_METADATA || payload.source !== 'tx') return undefined

  const byMid = await fetchQQSongDetail(payload.songmid)
  const query = [base.title, base.artist].filter(Boolean).join(' ')
  const candidates = byMid ? [byMid] : query ? await searchQQSongs(query) : []
  const best = candidates
    .map((candidate) => ({ candidate, score: byMid && candidate.mid === byMid.mid ? 99 : scoreMetadataMatch(base, candidate) }))
    .sort((left, right) => right.score - left.score)[0]

  if (!best || best.score < 3) return undefined

  const songmid = best.candidate.mid ?? payload.songmid
  const [lyrics, cover] = await Promise.all([
    fetchQQLyrics(songmid),
    fetchCover(best.candidate.albumImg),
  ])

  return {
    title: best.candidate.name,
    artist: best.candidate.artist,
    artists: splitArtists(best.candidate.artist),
    album: best.candidate.album,
    albumId: best.candidate.albumId,
    year: best.candidate.year,
    lyrics,
    cover,
  }
}

async function readExistingMetadata(filePath: string): Promise<IAudioMetadata | undefined> {
  return parseFile(filePath, { skipCovers: false, skipPostHeaders: true }).catch(() => undefined)
}

async function writeTags(filePath: string, metadata: NormalizedMetadata): Promise<string | undefined> {
  if (!taggingEnv.TAGGING_WRITE_TAGS) return 'tag writing disabled'

  const ext = path.extname(filePath).toLowerCase()
  if (!supportedTagWriteExtensions.has(ext)) {
    return `tag writing unsupported for ${ext || 'unknown extension'}`
  }

  if (ext === '.mp3') {
    const tags: NodeID3.Tags = {}
    if (metadata.title) tags.title = metadata.title
    if (metadata.artist) tags.artist = metadata.artist
    if (metadata.album) tags.album = metadata.album
    if (metadata.year) tags.year = metadata.year
    if (metadata.lyrics) tags.unsynchronisedLyrics = { language: 'zho', text: metadata.lyrics }
    if (metadata.cover) {
      tags.image = {
        mime: metadata.cover.mime,
        type: { id: NodeID3.TagConstants.AttachedPicture.PictureType.FRONT_COVER },
        description: 'Cover',
        imageBuffer: metadata.cover.data,
      }
    }
    if (metadata.albumId) {
      tags.userDefinedText = [{ description: 'QQMusic Album ID', value: metadata.albumId }]
    }

    const result = NodeID3.update(tags, filePath)
    if (result instanceof Error) throw result
    return undefined
  }

  const flac = new Metaflac(filePath) as MetaflacFile
  setFlacTag(flac, 'TITLE', metadata.title)
  setFlacTag(flac, 'ARTIST', metadata.artists?.length ? metadata.artists : metadata.artist)
  setFlacTag(flac, 'ALBUM', metadata.album)
  setFlacTag(flac, 'DATE', metadata.year)
  setFlacTag(flac, 'LYRICS', metadata.lyrics)
  setFlacTag(flac, 'QQMUSIC_ALBUMID', metadata.albumId)
  if (metadata.cover) {
    flac.pictures = []
    flac.picturesSpecs = []
    flac.picturesDatas = []
    flac.importPictureFromBuffer(metadata.cover.data)
  }
  flac.save()
  return undefined
}

async function writeEmbySidecars(finalPath: string, metadata: NormalizedMetadata): Promise<{
  lyricsPath?: string
  coverPath?: string
}> {
  const sidecars = buildSidecarPaths(finalPath, metadata)
  if (sidecars.lyricsPath && metadata.lyrics) {
    await fs.writeFile(sidecars.lyricsPath, `${normalizeLyrics(metadata.lyrics)}\n`, 'utf8')
  }

  if (sidecars.coverPath && metadata.cover) {
    await fs.writeFile(sidecars.coverPath, metadata.cover.data)
  }

  return sidecars
}

function setFlacTag(flac: MetaflacFile, name: string, value: string | string[] | undefined): void {
  flac.removeTag(name)
  const values = Array.isArray(value) ? value : value ? [value] : []
  for (const item of values) {
    if (item.trim()) flac.setTag(`${name}=${item.trim()}`)
  }
}

async function tagWithBuiltinProvider(payload: TagTrackFileJobPayload): Promise<TaggingResult> {
  const existing = await readExistingMetadata(payload.rawPath)
  const payloadMetadata = mergePayloadMetadata(payload, existing)
  const onlineMetadata = await resolveOnlineMetadata(payload, payloadMetadata).catch(() => undefined)
  const metadata = mergeOnlineMetadata(payloadMetadata, onlineMetadata)
  const targetPath = buildFinalPath(payload, metadata)
  const finalPath = await copyRawToLibrary(payload.rawPath, targetPath)
  const warnings: string[] = []

  const shouldWriteTags = supportedTagWriteExtensions.has(path.extname(finalPath).toLowerCase())
  const writeWarning = shouldWriteTags
    ? await writeTags(finalPath, metadata)
    : `tag writing unsupported for ${path.extname(finalPath).toLowerCase() || 'unknown extension'}`
  if (writeWarning) warnings.push(writeWarning)
  const sidecars = await writeEmbySidecars(finalPath, metadata)

  return {
    mode: 'builtin',
    finalPath,
    lyricsPath: sidecars.lyricsPath,
    coverPath: sidecars.coverPath,
    warnings: warnings.length ? warnings : undefined,
  }
}

export function createTaggingProvider(): TaggingProvider {
  return {
    async tagFile(payload) {
      if (!await pathExists(payload.rawPath)) {
        throw new Error(`Inbox file does not exist: ${payload.rawPath}`)
      }

      return tagWithBuiltinProvider(payload)
    },
  }
}

export const taggingInternals = {
  matchScore,
  matchArtist,
  scoreMetadataMatch,
  safePathSegment,
  buildFinalPath,
  buildSidecarPaths,
  mergePayloadMetadata,
}
