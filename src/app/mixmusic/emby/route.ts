import { dispatchEmbyRequest } from '@/lib/emby/dispatch'
import { embyCorsPreflight } from '@/lib/emby/cors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function handle(request: Request): Promise<Response> {
  return dispatchEmbyRequest(request, '/')
}

export async function GET(request: Request): Promise<Response> {
  return handle(request)
}

export async function POST(request: Request): Promise<Response> {
  return handle(request)
}

export async function PUT(request: Request): Promise<Response> {
  return handle(request)
}

export async function PATCH(request: Request): Promise<Response> {
  return handle(request)
}

export async function DELETE(request: Request): Promise<Response> {
  return handle(request)
}

export async function OPTIONS(): Promise<Response> {
  return embyCorsPreflight()
}
