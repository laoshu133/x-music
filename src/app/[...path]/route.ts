import { dispatchEmbyRequest } from '@/lib/emby/dispatch'
import { embyCorsPreflight } from '@/lib/emby/cors'
import { isReservedManagementPath, normalizeEmbyPath } from '@/lib/emby/paths'
import { getCurrentAccount } from '@/lib/session'
import { ampcastAutoConnectConfig, ampcastAutoInitHtml, playerPathFromEmbyPath, proxyToAmpcast } from '@/lib/ampcast/proxy'
import { ensureUpstreamEmbyUserForAccount } from '@/lib/emby/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = {
  params: Promise<{ path?: string[] }>
}

async function handle(request: Request, context: RouteContext): Promise<Response> {
  const params = await context.params
  const embyPath = normalizeEmbyPath(params.path ?? [])
  if (isAmpcastAutoInitPath(embyPath)) return ampcastAutoInitResponse(request)

  const playerPath = playerPathFromEmbyPath(embyPath)
  if (playerPath) return proxyToAmpcast(request, playerPath)

  if (isReservedManagementPath(embyPath)) {
    return Response.json({ error: 'Reserved XMusic path cannot be proxied as Emby API' }, { status: 404 })
  }
  if (request.method === 'GET' && isBrowserNavigation(request) && !isLikelyEmbyPath(embyPath)) {
    return friendlyNotFoundResponse(embyPath)
  }
  return dispatchEmbyRequest(request, embyPath)
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return handle(request, context)
}

export async function HEAD(request: Request, context: RouteContext): Promise<Response> {
  return handle(request, context)
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return handle(request, context)
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  return handle(request, context)
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return handle(request, context)
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return handle(request, context)
}

export async function OPTIONS(): Promise<Response> {
  return embyCorsPreflight()
}

function isBrowserNavigation(request: Request): boolean {
  const accept = request.headers.get('accept')?.toLowerCase() ?? ''
  const mode = request.headers.get('sec-fetch-mode')?.toLowerCase()
  return accept.includes('text/html') || mode === 'navigate'
}

function isAmpcastAutoInitPath(pathname: string): boolean {
  const lower = pathname.toLowerCase()
  return lower === '/@player/auto-init' || lower === '/%40player/auto-init'
}

async function ampcastAutoInitResponse(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  const account = await getCurrentAccount()
  if (!account) {
    return new Response(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>需要登录 | XMusic</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f8fa;color:#15181d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{width:min(520px,calc(100vw - 40px));text-align:left}
    h1{margin:0 0 12px;font-size:26px}
    p{margin:0 0 20px;color:#59616d;line-height:1.6}
    a{color:#0f62fe;text-decoration:none;font-weight:600}
  </style>
</head>
<body>
  <main>
    <h1>需要登录</h1>
    <p>请先登录 XMusic，然后再打开内嵌播放器。</p>
    <a href="/">返回 XMusic 首页</a>
  </main>
</body>
</html>`, {
      status: 401,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  }

  const ampcastAccount = await ensureUpstreamEmbyUserForAccount(account).catch(() => account)
  const origin = new URL(request.url).origin
  return new Response(ampcastAutoInitHtml(ampcastAutoConnectConfig(ampcastAccount, origin)), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function isLikelyEmbyPath(pathname: string): boolean {
  const prefixes = [
    '/Audio',
    '/Artists',
    '/Albums',
    '/Genres',
    '/Items',
    '/MusicGenres',
    '/Playlists',
    '/Sessions',
    '/System',
    '/Users',
    '/Videos',
  ]
  return prefixes.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

function friendlyNotFoundResponse(pathname: string): Response {
  return new Response(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>页面不存在 | XMusic</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f8fa;color:#15181d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{width:min(560px,calc(100vw - 40px))}
    h1{margin:0 0 12px;font-size:28px}
    p{margin:0 0 20px;color:#59616d;line-height:1.6}
    code{padding:2px 6px;border-radius:6px;background:#eceff3}
    a{color:#0f62fe;text-decoration:none;font-weight:600}
  </style>
</head>
<body>
  <main>
    <h1>页面不存在</h1>
    <p>没有找到 <code>${escapeHtml(pathname)}</code> 对应的 XMusic 页面。如果你是在配置播放器，请使用 Emby 客户端连接服务地址。</p>
    <a href="/">返回 XMusic 首页</a>
  </main>
</body>
</html>`, {
    status: 404,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
