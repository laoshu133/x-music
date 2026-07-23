import { NextResponse } from 'next/server'
import { summarizeAccount } from '@/lib/db/accounts'
import { getCurrentAccount } from '@/lib/session'
import { buildQQLoginState, qqMusicErrorResponse } from '@/lib/qq'
import { refreshAccountQQAuthorization } from '@/lib/qq/auth-refresh'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  const account = await getCurrentAccount({ verifyQQ: false })
  if (!account) return NextResponse.json({ error: 'Login required', code: 'AUTH_REQUIRED' }, { status: 401 })
  if (account.qqAuthState === 'missing') return NextResponse.json({ error: 'QQ authorization required', code: 'QQ_AUTH_REQUIRED' }, { status: 428 })
  try {
    const refreshed = await refreshAccountQQAuthorization(account)
    const state = buildQQLoginState(refreshed.result.cookie, 'request')
    return NextResponse.json({
      refreshed: true,
      changed: refreshed.result.changed,
      keyRefreshed: refreshed.result.keyRefreshed,
      tokenRefreshed: refreshed.result.tokenRefreshed,
      refreshedAt: refreshed.result.refreshedAt,
      hasQQMusicKey: Boolean(state.qqmusicKey),
      accessTokenExpiresAt: state.accessTokenExpiresAt,
      upstreamCode: refreshed.result.upstreamCode,
      account: summarizeAccount(refreshed.account),
    })
  } catch (error) {
    return qqMusicErrorResponse(error)
  }
}
