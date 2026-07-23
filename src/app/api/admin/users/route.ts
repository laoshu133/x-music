import { requireAdmin } from '@/lib/admin'
import { getAccountDetail, getAccountFavorites, getAccountProfile, getAccountRecentPlays, listAccountSummaries } from '@/lib/db/accounts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const forbidden = await requireAdmin()
  if (forbidden) return forbidden

  const url = new URL(request.url)
  const userId = url.searchParams.get('userId')
  const section = url.searchParams.get('section')
  if (userId) {
    const page = positiveInt(url.searchParams.get('page'), 1)
    const limit = positiveInt(url.searchParams.get('limit'), 50)
    if (section === 'profile') {
      const profile = getAccountProfile(userId)
      if (!profile) return Response.json({ error: 'User not found' }, { status: 404 })
      return Response.json(profile)
    }
    if (section === 'favorites') {
      const favorites = await getAccountFavorites(userId, page, limit)
      if (!favorites) return Response.json({ error: 'User not found' }, { status: 404 })
      return Response.json(favorites)
    }
    if (section === 'plays') {
      const recentPlays = getAccountRecentPlays(userId, page, limit)
      if (!recentPlays) return Response.json({ error: 'User not found' }, { status: 404 })
      return Response.json(recentPlays)
    }
    const detail = await getAccountDetail(userId)
    if (!detail) return Response.json({ error: 'User not found' }, { status: 404 })
    return Response.json(detail)
  }

  return Response.json({
    items: listAccountSummaries(),
  })
}

function positiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
