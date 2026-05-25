import crypto from 'node:crypto'
import { getEffectiveSettings } from '@/lib/db/settings'
import { createLocalAccessToken } from '@/lib/emby/tokens'

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

const ampcastInstalledVersion = '0.9.28'
const localServerId = 'x-music'
const localMusicLibraryId = 'x-music-music'
const localMusicLibraryTitle = 'XMusic'
const defaultHiddenServices = {
  'spotify/charts': true,
  'spotify/featured-playlists': true,
  'spotify/playlists-by-category': true,
  'spotify/new-albums': true,
  airsonic: true,
  ampache: true,
  emby: false,
  gonic: true,
  ibroadcast: true,
  jellyfin: true,
  navidrome: true,
  plex: true,
  subsonic: true,
}

type AmpcastAccount = {
  qqUin: string
  embyUsername: string
  embyPassword: string
  embyUserId?: string
}

type AmpcastAutoConnectConfig = {
  service: 'emby'
  host: string
  userName: string
  userId: string
  token: string
  serverId: string
  libraryId: string
  libraries: Array<{ id: string; title: string; type: string }>
}

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
  let response: Response
  try {
    response = await fetch(upstreamUrl, {
      method,
      headers,
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(settings.emby.proxyTimeoutMs),
      duplex: body ? 'half' : undefined,
    } as RequestInit & { duplex?: 'half' })
  } catch (error) {
    return ampcastUnavailableResponse(request, upstreamBaseUrl, error)
  }

  if (isPlayerDocumentRequest(request, playerPath, method) && response.status >= 500) {
    return ampcastUnavailableResponse(request, upstreamBaseUrl, undefined, response.status)
  }

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
  if (lowerPath === '/@player/auto-init' || lowerPath === '/%40player/auto-init') return undefined
  if (lowerPath === '/@player') return '/'
  if (lowerPath.startsWith('/@player/')) return embyPath.slice('/@player'.length)
  if (lowerPath === '/%40player') return '/'
  if (lowerPath.startsWith('/%40player/')) return embyPath.slice('/%40player'.length)
  if (isAmpcastRootAssetPath(embyPath)) return embyPath
  return undefined
}

export function ampcastAutoConnectConfig(account: AmpcastAccount, host: string): AmpcastAutoConnectConfig {
  return {
    service: 'emby',
    host,
    userName: account.embyUsername,
    userId: localUserId(account),
    token: createLocalAccessToken(account),
    serverId: localServerId,
    libraryId: localMusicLibraryId,
    libraries: [
      { id: localMusicLibraryId, title: localMusicLibraryTitle, type: 'music' },
    ],
  }
}

export function ampcastAutoInitHtml(config: AmpcastAutoConnectConfig): string {
  const configJson = escapeScriptJson(JSON.stringify(config))
  const hiddenServicesJson = escapeScriptJson(JSON.stringify(defaultHiddenServices))
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>正在打开播放器 | XMusic</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f8fa;color:#15181d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{width:min(520px,calc(100vw - 40px));text-align:left}
    h1{margin:0 0 12px;font-size:26px}
    p{margin:0;color:#59616d;line-height:1.6}
  </style>
</head>
<body>
  <main>
    <h1>正在打开播放器</h1>
    <p>正在准备连接信息，请稍候。</p>
  </main>
  <script>
    (() => {
      const config = ${configJson};
      const hiddenServices = ${hiddenServicesJson};
      const prefix = 'ampcast/' + config.service + '/';
      const currentHost = window.location.origin;
      const existingDeviceId = localStorage.getItem(prefix + 'deviceId');
      const deviceId = existingDeviceId || Math.random().toString(36).slice(2) + Date.now().toString(36);
      const now = String(Date.now());
      localStorage.setItem(prefix + 'host', currentHost);
      localStorage.setItem(prefix + 'userName', config.userName || '');
      localStorage.setItem(prefix + 'serverId', config.serverId || 'x-music');
      localStorage.setItem(prefix + 'userId', config.userId || '');
      localStorage.setItem(prefix + 'token', config.token);
      localStorage.setItem(prefix + 'deviceId', deviceId);
      localStorage.setItem(prefix + 'isLocal', 'true');
      localStorage.setItem(prefix + 'connectedAt', now);
      localStorage.setItem(prefix + 'useManualLogin', 'true');
      localStorage.setItem(prefix + 'libraryId', config.libraryId || 'x-music-music');
      localStorage.setItem(prefix + 'libraries', JSON.stringify(config.libraries || []));
      localStorage.setItem('ampcast/installed-version', '${ampcastInstalledVersion}');
      localStorage.setItem('ampcast/playback/repeatMode', localStorage.getItem('ampcast/playback/repeatMode') || '0');
      localStorage.setItem('ampcast/services/fields', localStorage.getItem('ampcast/services/fields') || '');
      localStorage.setItem('ampcast/services/hidden', JSON.stringify(hiddenServices));
      localStorage.setItem('ampcast/sources/selectedId', config.service);
      localStorage.setItem('ampcast/x-music/autoconnect-applied', now);
      requestAnimationFrame(() => window.location.replace('/@player/'));
    })();
  </script>
</body>
</html>`
}

function localUserId(account: AmpcastAccount): string {
  return account.embyUserId ?? crypto.createHash('sha1').update(`${localServerId}:${account.qqUin}:${account.embyUsername}`).digest('hex')
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

function isPlayerDocumentRequest(request: Request, playerPath: string, method: string): boolean {
  if (method !== 'GET') return false
  if (playerPath !== '/' && playerPath !== '') return false
  const accept = request.headers.get('accept')?.toLowerCase() ?? ''
  const mode = request.headers.get('sec-fetch-mode')?.toLowerCase()
  return !accept || accept.includes('text/html') || mode === 'navigate'
}

function ampcastUnavailableResponse(request: Request, upstreamBaseUrl: URL, error?: unknown, upstreamStatus?: number): Response {
  const status = 502
  if (!isBrowserDocumentRequest(request)) {
    return new Response('Ampcast upstream is unavailable', {
      status,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  }

  const detail = upstreamStatus
    ? `上游返回了 ${upstreamStatus} 状态。`
    : error instanceof Error && error.name === 'TimeoutError'
      ? '连接上游超时。'
      : '无法连接到上游服务。'

  return new Response(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>播放器暂时不可用 | XMusic</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f8fa;color:#15181d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{width:min(620px,calc(100vw - 40px));text-align:left}
    h1{margin:0 0 12px;font-size:28px}
    p{margin:0 0 18px;color:#59616d;line-height:1.6}
    code{padding:2px 6px;border-radius:6px;background:#eceff3;word-break:break-all}
    a{color:#0f62fe;text-decoration:none;font-weight:600}
  </style>
</head>
<body>
  <main>
    <h1>播放器暂时不可用</h1>
    <p>${escapeHtml(detail)}请检查上游 ampcast 服务状态。</p>
    <p>当前上游：<code>${escapeHtml(upstreamBaseUrl.toString())}</code></p>
    <a href="/">返回 XMusic 首页</a>
  </main>
</body>
</html>`, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function isBrowserDocumentRequest(request: Request): boolean {
  const accept = request.headers.get('accept')?.toLowerCase() ?? ''
  const mode = request.headers.get('sec-fetch-mode')?.toLowerCase()
  return accept.includes('text/html') || mode === 'navigate'
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeScriptJson(value: string): string {
  return value
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

function joinPaths(basePath: string, childPath: string): string {
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
  const child = childPath.startsWith('/') ? childPath : `/${childPath}`
  return `${base}${child}` || '/'
}
