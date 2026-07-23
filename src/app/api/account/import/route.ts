import { bindQQAuthorization, getAccountByUserId, refreshAccountQQProfile, summarizeAccount } from '@/lib/db/accounts'
import { qqMusicErrorResponse } from '@/lib/qq'
import { getCurrentAccount } from '@/lib/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const account = await getCurrentAccount({ verifyQQ: false })
  if (!account) return Response.json({ error: 'Login required', code: 'AUTH_REQUIRED' }, { status: 401 })
  const body = await request.json().catch(() => undefined) as { cookie?: unknown } | undefined
  if (typeof body?.cookie !== 'string' || !body.cookie.trim()) return Response.json({ error: 'Missing cookie' }, { status: 400 })
  try {
    bindQQAuthorization(account.userId, body.cookie)
    const refreshed = await refreshAccountQQProfile(account.userId).catch(() => undefined)
    return Response.json(summarizeAccount(refreshed ?? getAccountByUserId(account.userId)!))
  } catch (error) {
    if (error instanceof Error && error.message === 'QQ_ALREADY_BOUND') {
      return Response.json({ error: 'This QQ account is already bound to another user', code: 'QQ_ALREADY_BOUND' }, { status: 409 })
    }
    return qqMusicErrorResponse(error)
  }
}
