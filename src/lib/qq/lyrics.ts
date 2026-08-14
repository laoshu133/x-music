import { getCachedTextResource } from '@/lib/cache/resources'

interface LegacyLyricResponse {
  lyric?: string
}

export async function getQQLyrics(
  songmid: string,
  options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
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
  }).catch(() => undefined)

  return text && looksLikeTimedLyrics(text) ? text : undefined
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

function normalizeLyrics(value: string): string {
  return value.replace(/\r\n?/g, '\n').trimEnd()
}

function looksLikeTimedLyrics(value: string): boolean {
  return /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/.test(value)
}
