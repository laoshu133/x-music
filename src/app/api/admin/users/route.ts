import { requireAdmin } from '@/lib/admin'
import { listAccountSummaries } from '@/lib/db/accounts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  const forbidden = await requireAdmin()
  if (forbidden) return forbidden

  return Response.json({
    items: listAccountSummaries(),
  })
}
