import { dispatchEmbyRequest } from '@/lib/emby/dispatch'
import { embyCorsPreflight } from '@/lib/emby/cors'
import { isReservedManagementPath, normalizeEmbyPath } from '@/lib/emby/paths'
import { playerPathFromEmbyPath, proxyToAmpcast } from '@/lib/ampcast/proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = {
  params: Promise<{ path?: string[] }>
}

async function handle(request: Request, context: RouteContext): Promise<Response> {
  const params = await context.params
  const embyPath = normalizeEmbyPath(params.path ?? [])
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
