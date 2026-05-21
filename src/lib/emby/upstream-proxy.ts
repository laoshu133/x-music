import crypto from 'node:crypto'
import { getEffectiveSettings } from '@/lib/db/settings'
import { markRequestSource } from '@/lib/request-log'
import { listAccounts } from '@/lib/db/accounts'
import { embyAuthorizationHeader, getEmbyAccessToken } from './auth'

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

export async function proxyToUpstreamEmby(request: Request, embyPath: string): Promise<Response> {
  const settings = getEffectiveSettings()
  if (!settings.emby.baseUrl) {
    return Response.json({
      error: 'Upstream Emby is not configured',
      actionable: 'Set Emby base URL in /admin or EMBY_UPSTREAM_URL.',
    }, { status: 502 })
  }

  const incomingUrl = new URL(request.url)
  const upstreamUrl = new URL(settings.emby.baseUrl)
  upstreamUrl.pathname = joinPaths(upstreamUrl.pathname, embyPath)
  upstreamUrl.search = incomingUrl.search

  const headers = new Headers()
  request.headers.forEach((value, key) => {
    if (!hopByHopHeaders.has(key.toLowerCase())) headers.set(key, value)
  })
  const account = findAccountForRequest(request)
  const token = await getEmbyAccessToken(account)
  applyToken(upstreamUrl, headers, token)
  const method = request.method.toUpperCase()
  const init = {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : request.body,
    cache: 'no-store',
    signal: AbortSignal.timeout(settings.emby.proxyTimeoutMs),
    duplex: method === 'GET' || method === 'HEAD' ? undefined : 'half',
  } as RequestInit & { duplex?: 'half' }
  const response = await fetch(upstreamUrl, init)

  const responseHeaders = new Headers(response.headers)
  responseHeaders.set('x-mixmusic-source', 'upstream')
  return markRequestSource(new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  }), 'upstream')
}

function findAccountForRequest(request: Request) {
  const incomingUrl = new URL(request.url)
  const token = request.headers.get('X-Emby-Token')
    ?? request.headers.get('X-MediaBrowser-Token')
    ?? incomingUrl.searchParams.get('api_key')
    ?? incomingUrl.searchParams.get('ApiKey')
  if (!token) return undefined
  return listAccounts().find(account => token === localAccessToken(account))
}

function localAccessToken(account: { qqUin: string; embyUsername: string; embyPassword: string }): string {
  return crypto
    .createHash('sha256')
    .update(`mixmusic:${account.qqUin}:${account.embyUsername}:${account.embyPassword}`)
    .digest('hex')
}

function applyToken(url: URL, headers: Headers, token: string | undefined): void {
  if (!token) return
  url.searchParams.set('api_key', token)
  headers.set('X-Emby-Token', token)
  headers.set('X-Emby-Authorization', embyAuthorizationHeader(token))
}

function joinPaths(basePath: string, embyPath: string): string {
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
  const child = embyPath.startsWith('/') ? embyPath : `/${embyPath}`
  return `${base}${child}` || '/'
}
