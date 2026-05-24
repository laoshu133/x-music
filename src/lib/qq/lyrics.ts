import { getCachedTextResource } from '@/lib/cache/resources'
import { getQQSongDetail } from './song'

interface PlayLyricInfoResponse {
  code?: number
  lyric?: PlayLyricInfoModule
  req?: PlayLyricInfoModule
}

interface PlayLyricInfoModule {
  code?: number
  data?: {
    lyric?: string
    qrc?: unknown
    trans?: string
    roma?: string
    songID?: number
  }
}

interface PlayLyricInfoPayload {
  lyric?: string
  qrc?: unknown
  trans?: string
  roma?: string
  songID?: number
}

interface QQSongDetailResponse {
  code?: number
  songinfo?: {
    code?: number
    data?: {
      track_info?: {
        id?: number
        mid?: string
      }
    }
  }
}

interface LegacyLyricResponse {
  lyric?: string
}

export async function getQQLyrics(songmid: string, options: { songId?: number; timeoutMs?: number } = {}): Promise<string | undefined> {
  const songId = options.songId ?? await resolveQQSongId(songmid, options.timeoutMs).catch(() => undefined)
  const modern = await fetchQQPlayLyricInfo(songmid, { ...options, songId }).catch(() => undefined)
  if (modern) return modern
  return fetchLegacyQQLyrics(songmid, options).catch(() => undefined)
}

export function qqLegacyLyricsUrl(songmid: string): string {
  return `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?${new URLSearchParams({
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
  })}`
}

export function qqPlayLyricInfoCacheUrl(): string {
  return 'https://u.y.qq.com/cgi-bin/musicu.fcg'
}

export function qqPlayLyricInfoCacheBody(songmid: string, songId?: number): string {
  return JSON.stringify(playLyricInfoBody(songmid, songId))
}

async function fetchQQPlayLyricInfo(songmid: string, options: { songId?: number; timeoutMs?: number }): Promise<string | undefined> {
  const text = await getCachedTextResource({
    source: 'tx',
    resourceType: 'lyrics',
    url: 'https://u.y.qq.com/cgi-bin/musicu.fcg',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      referer: 'https://y.qq.com',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36',
    },
    body: JSON.stringify(playLyricInfoBody(songmid, options.songId)),
    timeoutMs: options.timeoutMs ?? 10_000,
    transform: (value) => normalizeLyricsFromPlayLyricInfo(JSON.parse(value) as PlayLyricInfoResponse),
  })
  return text && looksLikeTimedLyrics(text) ? text : undefined
}

async function fetchLegacyQQLyrics(songmid: string, options: { timeoutMs?: number }): Promise<string | undefined> {
  const text = await getCachedTextResource({
    source: 'tx',
    resourceType: 'lyrics',
    url: qqLegacyLyricsUrl(songmid),
    headers: {
      referer: 'https://y.qq.com/',
      'user-agent': 'Mozilla/5.0',
    },
    timeoutMs: options.timeoutMs ?? 10_000,
    transform: (value) => {
      const data = JSON.parse(value) as LegacyLyricResponse
      return data.lyric ? normalizeLyrics(Buffer.from(data.lyric, 'base64').toString('utf8')) : ''
    },
  })
  return text?.trim() ? text : undefined
}

function playLyricInfoBody(songmid: string, songId?: number): unknown {
  const param = {
    ...(songId ? { songID: songId } : { songMID: songmid }),
    format: 'json',
    crypt: 1,
    ct: 19,
    cv: 1873,
    interval: 0,
    lrc_t: 0,
    qrc: 1,
    qrc_t: 0,
    roma: 1,
    roma_t: 0,
    trans: 1,
    trans_t: 0,
    type: -1,
  }

  return {
    comm: {
      ct: '19',
      cv: '1859',
      uin: '0',
    },
    req: {
      module: 'music.musichallSong.PlayLyricInfo',
      method: 'GetPlayLyricInfo',
      param,
    },
  }
}

function normalizeLyricsFromPlayLyricInfo(data: PlayLyricInfoResponse): string {
  const payload = data.req?.data ?? data.lyric?.data
  const normalized = normalizeLyricsFromPayload(payload)
  return looksLikeTimedLyrics(normalized) ? normalized : ''
}

function normalizeLyricsFromPayload(payload?: PlayLyricInfoPayload): string {
  if (!payload) return ''

  const lyric = decodeQQText(firstNonEmpty(
    payload.lyric,
    typeof payload.qrc === 'string' && payload.qrc !== '1' ? payload.qrc : undefined,
  ))
  const parsed = parseQQTimedLyric(lyric)
  if (!looksLikeTimedLyrics(parsed)) return ''

  const translation = parseQQLineLyric(decodeQQText(payload.trans))
  return mergeTranslatedLyrics(parsed, translation)
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find(value => value?.trim())
}

function decodeMaybeBase64(value: string): string {
  const trimmed = value.trim()
  if (trimmed.includes('[') || trimmed.includes('\n')) return trimmed
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8')
    return decoded.trim() ? decoded : value
  } catch {
    return value
  }
}

function decodeQQText(value?: string): string {
  if (!value) return ''
  const normalized = decodeMaybeBase64(value)
  if (isEncryptedHex(normalized)) return ''
  return normalized
}

function isEncryptedHex(value: string): boolean {
  const trimmed = value.trim()
  return /^[A-Fa-f0-9]{32,}$/.test(trimmed) && trimmed.length % 2 === 0 && !trimmed.includes('\n')
}

function parseQQTimedLyric(value: string): string {
  const content = removeLyricContentWrapper(value)
  const lines = content
    .replace(/\r/g, '')
    .replace(/\\n/g, '\n')
    .split('\n')
    .map(line => parseQQTimedLine(line))
    .filter((line): line is string => Boolean(line))
  return normalizeLyrics(lines.join('\n'))
}

function parseQQLineLyric(value: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const rawLine of removeLyricContentWrapper(value).replace(/\r/g, '').replace(/\\n/g, '\n').split('\n')) {
    const line = parseQQTimedLine(rawLine)
    if (!line) continue
    const match = line.match(/^(\[\d{2}:\d{2}\.\d{3}])(.+)$/)
    if (match?.[1] && match[2]?.trim()) result.set(match[1], match[2].trim())
  }
  return result
}

function parseQQTimedLine(rawLine: string): string | undefined {
  const line = rawLine.trim()
  if (!line) return undefined
  if (line.startsWith('[offset')) return line

  const millisecond = line.match(/^\[(\d+),\d+]/)
  if (millisecond?.[1]) {
    const tag = formatMilliseconds(Number(millisecond[1]))
    const text = line
      .replace(/^\[\d+,\d+]/, '')
      .replace(/\(\d+,\d+(?:,\d+)?\)/g, '')
      .trim()
    return tag && text ? `${tag}${text}` : undefined
  }

  const normal = line.match(/^(\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?])(.+)$/)
  if (!normal) return undefined
  const tag = normalizeTimeTag(normal[1])
  const text = normal[2]?.replace(/\(\d+,\d+(?:,\d+)?\)/g, '').trim()
  return tag && text ? `${tag}${text}` : undefined
}

function mergeTranslatedLyrics(lyrics: string, translations: Map<string, string>): string {
  if (!translations.size) return lyrics
  return lyrics
    .split('\n')
    .map(line => {
      const match = line.match(/^(\[\d{2}:\d{2}\.\d{3}])(.+)$/)
      const translated = match?.[1] ? translations.get(match[1]) : undefined
      return translated ? `${line}\n${match![1]}${translated}` : line
    })
    .join('\n')
}

function removeLyricContentWrapper(value: string): string {
  const match = value.match(/LyricContent="([\s\S]*?)"\/>/)
  return match?.[1] ? unescapeXml(match[1]) : value
}

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function normalizeTimeTag(tag: string): string {
  const match = tag.match(/^\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?]$/)
  if (!match?.[1] || !match[2]) return ''
  const ms = (match[3] ?? '0').padEnd(3, '0').slice(0, 3)
  return `[${match[1].padStart(2, '0')}:${match[2]}.${ms}]`
}

function formatMilliseconds(value: number): string {
  if (!Number.isFinite(value) || value < 0) return ''
  const ms = Math.trunc(value % 1000)
  const totalSeconds = Math.trunc(value / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.trunc(totalSeconds / 60)
  return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}]`
}

async function resolveQQSongId(songmid: string, timeoutMs?: number): Promise<number | undefined> {
  const detail = await getQQSongDetail(songmid).catch(() => undefined)
  const rawSongId = readRawNumber(detail?.raw, 'songId')
  if (rawSongId) return rawSongId

  const text = await getCachedTextResource({
    source: 'tx',
    resourceType: 'metadata',
    url: 'https://u.y.qq.com/cgi-bin/musicu.fcg',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      referer: 'https://y.qq.com/',
      'user-agent': 'Mozilla/5.0',
    },
    body: JSON.stringify({
      comm: {
        ct: 24,
        cv: 0,
      },
      songinfo: {
        method: 'get_song_detail_yqq',
        module: 'music.pf_song_detail_svr',
        param: {
          song_type: 0,
          song_mid: songmid,
        },
      },
    }),
    timeoutMs: timeoutMs ?? 10_000,
    transform: (value) => {
      const data = JSON.parse(value) as QQSongDetailResponse
      const songId = data.songinfo?.data?.track_info?.id
      return Number.isFinite(songId) ? String(songId) : ''
    },
  })

  const parsed = text ? Number(text.trim()) : undefined
  return Number.isFinite(parsed) ? parsed : undefined
}

function readRawNumber(raw: unknown, key: string): number | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = (raw as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeLyrics(value: string): string {
  return value.replace(/\r\n?/g, '\n').trimEnd()
}

function looksLikeTimedLyrics(value: string): boolean {
  return /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/.test(value)
}
