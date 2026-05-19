import { getEffectiveSettings } from '@/lib/db/settings'
import { markRequestSource } from '@/lib/request-log'

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
  if (settings.emby.apiKey && !upstreamUrl.searchParams.has('api_key')) {
    upstreamUrl.searchParams.set('api_key', settings.emby.apiKey)
  }

  const headers = new Headers()
  request.headers.forEach((value, key) => {
    if (!hopByHopHeaders.has(key.toLowerCase())) headers.set(key, value)
  })
  if (settings.emby.apiKey && !headers.has('X-Emby-Token')) {
    headers.set('X-Emby-Token', settings.emby.apiKey)
  }

  const method = request.method.toUpperCase()
  const response = await fetch(upstreamUrl, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : request.body,
    cache: 'no-store',
    signal: AbortSignal.timeout(settings.emby.proxyTimeoutMs),
    duplex: method === 'GET' || method === 'HEAD' ? undefined : 'half',
  } as RequestInit & { duplex?: 'half' })

  const responseHeaders = new Headers(response.headers)
  responseHeaders.set('x-mixmusic-source', 'upstream')
  return markRequestSource(new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  }), 'upstream')
}

function joinPaths(basePath: string, embyPath: string): string {
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
  const child = embyPath.startsWith('/') ? embyPath : `/${embyPath}`
  return `${base}${child}` || '/'
}
