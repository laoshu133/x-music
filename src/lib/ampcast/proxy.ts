import { getEffectiveSettings } from '@/lib/db/settings'

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

const rewriteableContentTypes = [
  'text/html',
  'text/css',
  'application/javascript',
  'text/javascript',
  'application/json',
  'application/manifest+json',
]

const rootAssetPathPatterns = [
  /^\/v\d+(?:\.\d+)*(?:\/|$)/i,
  /^\/assets(?:\/|$)/i,
  /^\/icons(?:\/|$)/i,
  /^\/lib(?:\/|$)/i,
  /^\/manifest(?:\.webmanifest|\.json)?$/i,
  /^\/service-worker\.js$/i,
  /^\/sw\.js$/i,
]

export async function proxyToAmpcast(request: Request, playerPath: string): Promise<Response> {
  const settings = getEffectiveSettings()
  const incomingUrl = new URL(request.url)
  const upstreamBaseUrl = new URL(settings.player.ampcastUrl)
  const upstreamUrl = new URL(upstreamBaseUrl)
  upstreamUrl.pathname = joinPaths(upstreamBaseUrl.pathname, playerPath)
  upstreamUrl.search = incomingUrl.search

  const headers = new Headers()
  request.headers.forEach((value, key) => {
    if (!hopByHopHeaders.has(key.toLowerCase())) headers.set(key, value)
  })
  headers.set('host', upstreamUrl.host)

  const method = request.method.toUpperCase()
  const body = method === 'GET' || method === 'HEAD' ? undefined : request.body ?? undefined
  const response = await fetch(upstreamUrl, {
    method,
    headers,
    body,
    cache: 'no-store',
    signal: AbortSignal.timeout(settings.emby.proxyTimeoutMs),
    duplex: body ? 'half' : undefined,
  } as RequestInit & { duplex?: 'half' })

  const responseHeaders = responseHeadersForDecodedBody(response.headers)
  responseHeaders.delete('content-security-policy')
  responseHeaders.delete('content-security-policy-report-only')
  responseHeaders.delete('x-frame-options')

  if (!shouldRewriteBody(response, method)) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  }

  const bodyText = await response.text()
  return new Response(rewriteRootRelativeUrls(bodyText), {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  })
}

export function playerPathFromEmbyPath(embyPath: string): string | undefined {
  const lowerPath = embyPath.toLowerCase()
  if (lowerPath === '/@player') return '/'
  if (lowerPath.startsWith('/@player/')) return embyPath.slice('/@player'.length)
  if (lowerPath === '/%40player') return '/'
  if (lowerPath.startsWith('/%40player/')) return embyPath.slice('/%40player'.length)
  if (isAmpcastRootAssetPath(embyPath)) return embyPath
  return undefined
}

function shouldRewriteBody(response: Response, method: string): boolean {
  if (method === 'HEAD') return false
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  return rewriteableContentTypes.some(type => contentType.includes(type))
}

function responseHeadersForDecodedBody(headers: Headers): Headers {
  const result = new Headers(headers)
  for (const header of decodedBodyHeaders) {
    result.delete(header)
  }
  return result
}

function rewriteRootRelativeUrls(value: string): string {
  return value
    .replace(/\b(href|src|action)=(["'])\/(?!\/|@player\/)/gi, '$1=$2/@player/')
    .replace(/url\((["']?)\/(?!\/|@player\/)/gi, 'url($1/@player/')
    .replace(/(["'`])\/(?!\/|@player\/)(v\d+(?:\.\d+)*(?:\/[^"'`]*)?|assets\/[^"'`]*|icons\/[^"'`]*|lib\/[^"'`]*|manifest(?:\.webmanifest|\.json)?|service-worker\.js|sw\.js)/gi, '$1/@player/$2')
}

function isAmpcastRootAssetPath(pathname: string): boolean {
  return rootAssetPathPatterns.some(pattern => pattern.test(pathname))
}

function joinPaths(basePath: string, childPath: string): string {
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
  const child = childPath.startsWith('/') ? childPath : `/${childPath}`
  return `${base}${child}` || '/'
}
