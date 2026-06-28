import { NextResponse } from 'next/server'
import { getAccountByQQ, summarizeAccount, updateAccountQQCookie } from '@/lib/db/accounts'
import { getStoredQQLoginState, updateStoredQQLoginCookie } from '@/lib/db/qq-session'
import { buildQQLoginState, refreshQQMusickey, qqMusicErrorResponse } from '@/lib/qq'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RefreshRequest = {
  cookie?: string
  persist?: boolean
}

export async function POST(request: Request) {
  const body = await readRefreshBody(request)
  try {
    const stored = body?.cookie ? undefined : getStoredQQLoginState()
    const result = await refreshQQMusickey({ cookie: body?.cookie ?? stored?.cookie })
    const shouldPersist = body?.persist !== false && !body?.cookie
    const refreshedState = buildQQLoginState(result.cookie, 'request')

    if (shouldPersist) {
      updateStoredQQLoginCookie(result.cookie)
      updateAccountQQCookie(result.cookie)
    }

    const account = shouldPersist ? getAccountByQQ(result.uin) : undefined
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
