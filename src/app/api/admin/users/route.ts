import { requireAdmin } from '@/lib/admin'
import { getAccountDetail, listAccountSummaries } from '@/lib/db/accounts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const forbidden = await requireAdmin()
  if (forbidden) return forbidden

  const qqUin = new URL(request.url).searchParams.get('qqUin')
  if (qqUin) {
    const detail = await getAccountDetail(qqUin)
    if (!detail) return Response.json({ error: 'User not found' }, { status: 404 })
    return Response.json(detail)
  }

  return Response.json({
    items: listAccountSummaries(),
  })
}
