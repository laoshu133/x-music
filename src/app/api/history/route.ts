import { listPlayHistory } from '@/lib/cache/store'
import { getCurrentAccount } from '@/lib/session'
import { pullEmbyPlayHistory, pushLocalPlayHistoryToEmby } from '@/lib/emby/history'
import { pushLocalPlayHistoryToQQ } from '@/lib/qq'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const account = await getCurrentAccount()
  if (!account) return Response.json({ error: 'Login required', code: 'AUTH_REQUIRED' }, { status: 401 })
  const url = new URL(request.url)
  const limit = Number(url.searchParams.get('limit') ?? 50)
  const remote = url.searchParams.get('remote')
  if (remote === 'emby' || (url.searchParams.get('sync') === 'pull' && !remote)) {
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
    list: listPlayHistory(account.userId, limit),
  })
}

export async function POST(request: Request): Promise<Response> {
  const account = await getCurrentAccount()
  if (!account) return Response.json({ error: 'Login required', code: 'AUTH_REQUIRED' }, { status: 401 })
  const url = new URL(request.url)
  if (url.searchParams.get('sync') !== 'push') {
    return Response.json({ error: 'POST /api/history expects sync=push' }, { status: 400 })
  }

  const limit = Number(url.searchParams.get('limit') ?? 200)
  if (url.searchParams.get('remote') === 'qq') {
    try {
      return Response.json(await pushLocalPlayHistoryToQQ({ userId: account.userId, cookie: account.qqCookie, limit }))
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
    }
  }

  if (url.searchParams.get('remote') !== 'emby') {
    return Response.json({ error: 'POST /api/history supports remote=emby or remote=qq' }, { status: 400 })
  }

  try {
    return Response.json(await pushLocalPlayHistoryToEmby({ account, limit }))
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
  }
}
