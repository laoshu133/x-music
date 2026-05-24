import { listPlayHistory } from '@/lib/cache/store'
import { getCurrentAccount } from '@/lib/session'
import { pullEmbyPlayHistory, pushLocalPlayHistoryToEmby } from '@/lib/emby/history'
import { pushLocalPlayHistoryToQQ } from '@/lib/qq'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const limit = Number(url.searchParams.get('limit') ?? 50)
  if (url.searchParams.get('remote') === 'emby' || url.searchParams.get('sync') === 'pull') {
    const account = await getCurrentAccount()
    try {
      return Response.json(await pullEmbyPlayHistory({
        account,
        limit,
        syncQQ: url.searchParams.get('syncQQ') !== 'false',
      }))
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
    }
  }

  return Response.json({
    source: 'local',
    list: listPlayHistory(limit),
  })
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (url.searchParams.get('sync') !== 'push') {
    return Response.json({ error: 'POST /api/history expects sync=push' }, { status: 400 })
  }

  const limit = Number(url.searchParams.get('limit') ?? 200)
  if (url.searchParams.get('remote') === 'qq') {
    const cookie = request.headers.get('x-qq-music-cookie') ?? undefined
    try {
      return Response.json(await pushLocalPlayHistoryToQQ({ cookie, limit }))
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
    }
  }

  if (url.searchParams.get('remote') !== 'emby') {
    return Response.json({ error: 'POST /api/history supports remote=emby or remote=qq' }, { status: 400 })
  }

  const account = await getCurrentAccount()
  try {
    return Response.json(await pushLocalPlayHistoryToEmby({ account, limit }))
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
  }
}
