import { dispatchEmbyRequest } from '@/lib/emby/dispatch'
import { embyCorsPreflight } from '@/lib/emby/cors'
import { isReservedManagementPath, normalizeEmbyPath } from '@/lib/emby/paths'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = {
  params: Promise<{ path?: string[] }>
}

async function handle(request: Request, context: RouteContext): Promise<Response> {
  const params = await context.params
  const embyPath = normalizeEmbyPath(params.path ?? [])

  if (isReservedManagementPath(embyPath)) {
    return Response.json({ error: 'Reserved XMusic path cannot be proxied as Emby API' }, { status: 404 })
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
