import { NextResponse } from 'next/server'
import { summarizeAccount } from '@/lib/db/accounts'
import { getCurrentAccount } from '@/lib/session'
import { buildQQLoginState, refreshQQMusickey, qqMusicErrorResponse, QQMusicError } from '@/lib/qq'
import { refreshAccountQQAuthorization } from '@/lib/qq/auth-refresh'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RefreshRequest = {
  cookie?: string
  persist?: boolean
}

export async function POST(request: Request) {
  const body = await readRefreshBody(request)
  try {
    const currentAccount = body?.cookie ? undefined : await getCurrentAccount({ verifyQQ: false })
    if (!body?.cookie && !currentAccount) {
      throw new QQMusicError('Login is required to refresh QQ authorization', 401, {
        actionable: '重新登录后再刷新授权。',
      })
    }

    const refreshed = currentAccount && body?.persist !== false && !body?.cookie
      ? await refreshAccountQQAuthorization(currentAccount)
      : undefined
    const result = refreshed?.result ?? await refreshQQMusickey({ cookie: body?.cookie ?? currentAccount?.qqCookie })
    const shouldPersist = body?.persist !== false && !body?.cookie && Boolean(currentAccount)
    const refreshedState = buildQQLoginState(result.cookie, 'request')
    const account = shouldPersist ? refreshed?.account : undefined
    return NextResponse.json({
      refreshed: true,
      uin: result.uin,
      changed: result.changed,
      keyRefreshed: result.keyRefreshed,
      tokenRefreshed: result.tokenRefreshed,
      refreshedAt: result.refreshedAt,
      hasQQMusicKey: Boolean(refreshedState.qqmusicKey),
      accessTokenExpiresAt: refreshedState.accessTokenExpiresAt,
      upstreamCode: result.upstreamCode,
      persisted: shouldPersist,
      account: account ? summarizeAccount(account) : undefined,
    })
  } catch (error) {
    return qqMusicErrorResponse(error)
  }
}

async function readRefreshBody(request: Request): Promise<RefreshRequest | undefined> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) return undefined
  return await request.json().catch(() => undefined) as RefreshRequest | undefined
}
