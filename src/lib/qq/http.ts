import { zzcSign } from './crypto'
import { logServiceEvent } from '@/lib/request-log'

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

export function qqMusicErrorResponse(error: unknown): Response {
  if (error instanceof QQMusicError) {
    const payload = error.payload && typeof error.payload === 'object' ? error.payload as Record<string, unknown> : undefined
    const status = error.status ?? 502
    const systemError = status >= 500
    const authExpired = payload?.code === 'QQ_AUTH_EXPIRED'
    logServiceEvent('qq_music_error_response', {
      error: error.message,
      status,
      payload: summarizeQQMusicErrorPayload(payload),
    }, 'error')
    return Response.json(
      {
        error: systemError
          ? '系统出错，请稍后重试。'
          : authExpired
            ? 'QQ 授权已失效，请重新登录。'
            : error.message,
        code: systemError ? 'SYSTEM_ERROR' : payload?.code,
        actionable: systemError ? '系统暂时无法完成请求，后台已记录错误。' : payload?.actionable,
      },
      { status },
    )
  }

  logServiceEvent('qq_music_unhandled_error', {
    error: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : undefined,
  }, 'error')
  return Response.json(
    {
      error: '系统出错，请稍后重试。',
      code: 'SYSTEM_ERROR',
      actionable: '系统暂时无法完成请求，后台已记录错误。',
    },
    { status: 503 },
  )
}

function summarizeQQMusicErrorPayload(payload: Record<string, unknown> | undefined): unknown {
  if (!payload) return undefined
  const response = payload.response && typeof payload.response === 'object'
    ? payload.response as Record<string, unknown>
    : undefined
  return {
    code: payload.code ?? response?.code,
    subcode: payload.subcode ?? response?.subcode,
    actionable: payload.actionable,
    cause: typeof payload.cause === 'string' ? payload.cause : undefined,
    keys: Array.isArray(payload.keys) ? payload.keys : undefined,
    dataKeys: Array.isArray(payload.dataKeys) ? payload.dataKeys : undefined,
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

export async function qqSignedPost<T>(body: unknown, init?: RequestInit): Promise<T> {
  const sign = zzcSign(JSON.stringify(body))
  return qqPost<T>(`https://u.y.qq.com/cgi-bin/musics.fcg?sign=${sign}`, body, {
    ...init,
    headers: {
      'user-agent': 'QQMusic 14090508(android 12)',
      ...init?.headers,
    },
  })
}
