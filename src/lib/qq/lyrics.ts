import { getCachedTextResource } from '@/lib/cache/resources'

interface PlayLyricInfoResponse {
  code?: number
  lyric?: {
    code?: number
    data?: {
      lyric?: string
      qrc?: unknown
      trans?: string
      songID?: number
    }
  }
}

interface LegacyLyricResponse {
  lyric?: string
}

export async function getQQLyrics(songmid: string, options: { songId?: number; timeoutMs?: number } = {}): Promise<string | undefined> {
  const modern = await fetchQQPlayLyricInfo(songmid, options).catch(() => undefined)
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

async function fetchQQPlayLyricInfo(songmid: string, options: { songId?: number; timeoutMs?: number }): Promise<string | undefined> {
  const text = await getCachedTextResource({
    source: 'tx',
    resourceType: 'lyrics',
    url: 'https://u.y.qq.com/cgi-bin/musicu.fcg',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
  return {
    comm: {
      ct: 24,
      cv: 0,
    },
    lyric: {
      module: 'music.musichallSong.PlayLyricInfo',
      method: 'GetPlayLyricInfo',
      param: {
        ...(songId ? { songID: songId } : {}),
        songMID: songmid,
        qrc: 1,
        roma: 1,
        trans: 1,
      },
    },
  }
}

function normalizeLyricsFromPlayLyricInfo(data: PlayLyricInfoResponse): string {
  const payload = data.lyric?.data
  const lyric = firstNonEmpty(payload?.lyric, typeof payload?.qrc === 'string' ? payload.qrc : undefined)
  const normalized = lyric ? normalizeLyrics(decodeMaybeBase64(lyric)) : ''
  return looksLikeTimedLyrics(normalized) ? normalized : ''
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

function normalizeLyrics(value: string): string {
  return value.replace(/\r\n?/g, '\n').trimEnd()
}

function looksLikeTimedLyrics(value: string): boolean {
  return /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/.test(value)
}
