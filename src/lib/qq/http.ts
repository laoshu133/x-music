import { zzcSign } from './crypto'

const DEFAULT_HEADERS = {
  accept: 'application/json, text/plain, */*',
  origin: 'https://y.qq.com',
  referer: 'https://y.qq.com/',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
}

export class QQMusicError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly payload?: unknown,
  ) {
    super(message)
    this.name = 'QQMusicError'
  }
}

async function parseQQResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  const normalized = text.trim().replace(/^callback\((.*)\);?$/, '$1')
  try {
    return JSON.parse(normalized) as T
  } catch (error) {
    throw new QQMusicError('Failed to parse QQ Music response', response.status, {
      cause: error instanceof Error ? error.message : String(error),
      body: text.slice(0, 500),
    })
  }
}

export async function qqGet<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...DEFAULT_HEADERS,
      ...init?.headers,
    },
    cache: 'no-store',
  })
  if (!response.ok) {
    throw new QQMusicError('QQ Music request failed', response.status)
  }
  return parseQQResponse<T>(response)
}

export async function qqPost<T>(url: string, body: unknown, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    method: 'POST',
    headers: {
      ...DEFAULT_HEADERS,
      'content-type': 'application/json',
      ...init?.headers,
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  if (!response.ok) {
    throw new QQMusicError('QQ Music request failed', response.status)
  }
  return parseQQResponse<T>(response)
}

export async function qqSignedPost<T>(body: unknown): Promise<T> {
  const sign = zzcSign(JSON.stringify(body))
  return qqPost<T>(`https://u.y.qq.com/cgi-bin/musics.fcg?sign=${sign}`, body, {
    headers: {
      'user-agent': 'QQMusic 14090508(android 12)',
    },
  })
}
