import { NextResponse } from 'next/server'
import { bindQQAuthorization, getAccountByUserId, refreshAccountQQProfile, summarizeAccount } from '@/lib/db/accounts'
import { exchangeQQMusicLoginCode, qqMusicErrorResponse } from '@/lib/qq'
import { getCurrentAccount } from '@/lib/session'
import { consumeQQAuthAttempt, readQQAuthAttempt } from '@/lib/db/qq-auth-attempts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const account = await getCurrentAccount({ verifyQQ: false })
  if (!account) return NextResponse.json({ error: 'Login required', code: 'AUTH_REQUIRED' }, { status: 401 })
  const authorization = await readAuthorization(request)
  if (!authorization?.code || !authorization.state) return NextResponse.json({ error: 'Missing code or state' }, { status: 400 })
  try {
    readQQAuthAttempt({ userId: account.userId, method: 'mobile', verifier: authorization.state })
    const session = await exchangeQQMusicLoginCode({ code: authorization.code })
    bindQQAuthorization(account.userId, session.cookie)
    consumeQQAuthAttempt(account.userId, 'mobile')
    const refreshed = await refreshAccountQQProfile(account.userId).catch(() => undefined)
    return NextResponse.json({ isOk: true, message: '授权成功', account: summarizeAccount(refreshed ?? getAccountByUserId(account.userId)!) })
  } catch (error) {
    if (error instanceof Error && error.message === 'QQ_ALREADY_BOUND') {
      return NextResponse.json({ error: 'This QQ account is already bound to another user', code: 'QQ_ALREADY_BOUND' }, { status: 409 })
    }
    return qqMusicErrorResponse(error)
  }
}

async function readAuthorization(request: Request): Promise<{ code?: string; state?: string } | undefined> {
  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => undefined) as { code?: string; state?: string; url?: string } | undefined
    return authorizationValues(body?.url, body?.code, body?.state)
  }
  const form = await request.formData().catch(() => undefined)
  return authorizationValues(undefined, form?.get('code')?.toString(), form?.get('state')?.toString())
}

function authorizationValues(urlText?: string, codeText?: string, stateText?: string): { code?: string; state?: string } {
  try {
    const url = new URL(urlText?.trim() ?? '')
    return { code: url.searchParams.get('code')?.trim() || undefined, state: url.searchParams.get('state')?.trim() || undefined }
  } catch {
    return { code: codeText?.trim() || undefined, state: stateText?.trim() || undefined }
  }
}
