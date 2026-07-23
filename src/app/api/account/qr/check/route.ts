import { NextResponse } from 'next/server'
import { checkQQLoginQr, qqMusicErrorResponse } from '@/lib/qq'
import { bindQQAuthorization, getAccountByUserId, refreshAccountQQProfile, summarizeAccount } from '@/lib/db/accounts'
import { getCurrentAccount } from '@/lib/session'
import { consumeQQAuthAttempt, readQQAuthAttempt } from '@/lib/db/qq-auth-attempts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const account = await getCurrentAccount({ verifyQQ: false })
  if (!account) return NextResponse.json({ error: 'Login required', code: 'AUTH_REQUIRED' }, { status: 401 })
  const body = await request.json().catch(() => undefined) as { attemptId?: string } | undefined
  if (!body?.attemptId) return NextResponse.json({ error: 'Missing authorization attempt' }, { status: 400 })
  try {
    const attempt = readQQAuthAttempt<{ ptqrtoken: string | number; qrsig: string }>({ id: body.attemptId, userId: account.userId, method: 'qr' })
    const result = await checkQQLoginQr(attempt)
    if (!result.isOk) return NextResponse.json(result)
    bindQQAuthorization(account.userId, result.session.cookie)
    consumeQQAuthAttempt(account.userId, 'qr')
    const refreshed = await refreshAccountQQProfile(account.userId).catch(() => undefined)
    return NextResponse.json({ ...result, account: summarizeAccount(refreshed ?? getAccountByUserId(account.userId)!) })
  } catch (error) {
    if (error instanceof Error && error.message === 'QQ_ALREADY_BOUND') {
      return NextResponse.json({ error: 'This QQ account is already bound to another user', code: 'QQ_ALREADY_BOUND' }, { status: 409 })
    }
    return qqMusicErrorResponse(error)
  }
}
