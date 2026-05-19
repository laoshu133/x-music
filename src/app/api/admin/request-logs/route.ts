import { listRequestLogs, type RequestSource } from '@/lib/db/request-logs'
import { withRequestLog } from '@/lib/request-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  return withRequestLog(request, async () => {
    const url = new URL(request.url)
    const source = url.searchParams.get('source')
    const status = url.searchParams.get('status')
    const logs = listRequestLogs({
      limit: Number(url.searchParams.get('limit') ?? 100),
      offset: Number(url.searchParams.get('offset') ?? 0),
      path: url.searchParams.get('path') ?? undefined,
      source: source === 'local' || source === 'upstream' ? source as RequestSource : undefined,
      status: status && /^\d+$/.test(status) ? Number(status) : undefined,
    })
    return Response.json({ list: logs })
  })
}
