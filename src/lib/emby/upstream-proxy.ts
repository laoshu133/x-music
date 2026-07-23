import { markRequestSource } from '@/lib/request-log'
import { listAccounts, markAccountActive } from '@/lib/db/accounts'
import { embyAuthorizationHeader, getDefaultUpstreamMusicLibraryId, getEmbyAccessToken } from './auth'
import { embyConfigForAccount } from './config'
import { findAccountByAccessToken, localEmbyUserId, readEmbyAccessToken } from './tokens'

const MUSIC_LIBRARY_ID = 'x-music-music'

const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
])

const decodedBodyHeaders = new Set([
  'content-encoding',
  'content-length',
])

export async function proxyToUpstreamEmby(request: Request, embyPath: string): Promise<Response> {
  const account = findAccountForRequest(request)
  const settings = embyConfigForAccount(account)
  if (!settings.baseUrl) {
    return Response.json({
      error: 'Upstream Emby is not configured',
      actionable: '在帐号配置中填写你的 Emby DSN。',
    }, { status: 502 })
  }

  const incomingUrl = new URL(request.url)
  const upstreamUrl = new URL(settings.baseUrl)
  upstreamUrl.pathname = joinPaths(upstreamUrl.pathname, embyPath)
  applyLocalUserMapping(upstreamUrl, account)
  upstreamUrl.search = incomingUrl.search
  await applyLocalLibraryMapping(upstreamUrl, account)

  const headers = new Headers()
  request.headers.forEach((value, key) => {
    if (!hopByHopHeaders.has(key.toLowerCase())) headers.set(key, value)
  })
  const token = await getEmbyAccessToken(account)
  applyToken(upstreamUrl, headers, token)
  const method = request.method.toUpperCase()
  const body = method === 'GET' || method === 'HEAD' ? undefined : request.body ?? undefined
  const init = {
    method,
    headers,
    body,
    cache: 'no-store',
    signal: AbortSignal.timeout(settings.proxyTimeoutMs),
    duplex: body ? 'half' : undefined,
  } as RequestInit & { duplex?: 'half' }
  const response = await fetch(upstreamUrl, init)

  const responseHeaders = responseHeadersForDecodedBody(response.headers)
  return markRequestSource(new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  }), 'upstream')
}

function applyLocalUserMapping(url: URL, account: ReturnType<typeof findAccountForRequest>): void {
  if (!account?.embyUserId) return
  const localId = localEmbyUserId(account.userId)
  url.pathname = url.pathname.replace(`/Users/${localId}`, `/Users/${account.embyUserId}`)
}

function responseHeadersForDecodedBody(headers: Headers): Headers {
  const result = new Headers(headers)
  for (const header of decodedBodyHeaders) {
    result.delete(header)
  }
  return result
}

function findAccountForRequest(request: Request) {
  const token = readEmbyAccessToken(request)
  if (!token) return undefined
  const account = findAccountByAccessToken(token)
  if (account) markAccountActive(account.userId)
  return account
}

function applyToken(url: URL, headers: Headers, token: string | undefined): void {
  if (!token) return
  url.searchParams.set('api_key', token)
  headers.set('X-Emby-Token', token)
  headers.set('X-Emby-Authorization', embyAuthorizationHeader(token))
}

async function applyLocalLibraryMapping(url: URL, account: ReturnType<typeof findAccountForRequest>): Promise<void> {
  for (const key of ['ParentId', 'parentId']) {
    if (url.searchParams.get(key) !== MUSIC_LIBRARY_ID) continue
    const upstreamMusicLibraryId = await getDefaultUpstreamMusicLibraryId(account).catch(() => undefined)
    if (upstreamMusicLibraryId) {
      url.searchParams.set(key, upstreamMusicLibraryId)
    } else {
      url.searchParams.delete(key)
    }
  }
}

function joinPaths(basePath: string, embyPath: string): string {
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
  const child = embyPath.startsWith('/') ? embyPath : `/${embyPath}`
  return `${base}${child}` || '/'
}
