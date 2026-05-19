import { listPlayHistory } from '@/lib/cache/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const limit = Number(url.searchParams.get('limit') ?? 50)

  return Response.json({
    source: 'local',
    list: listPlayHistory(limit),
  })
}
