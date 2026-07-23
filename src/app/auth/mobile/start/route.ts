import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { buildQQMobileAuthorizeUrl, randomAuthState } from '@/lib/qq/mobile-auth'
import { getCurrentAccount } from '@/lib/session'
import { createQQAuthAttempt } from '@/lib/db/qq-auth-attempts'

export const dynamic = 'force-dynamic'

export async function GET() {
  const account = await getCurrentAccount({ verifyQQ: false })
  if (!account) redirect('/')
  const headerList = await headers()
  const host = headerList.get('x-forwarded-host') ?? headerList.get('host') ?? 'localhost:3004'
  const protocol = headerList.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https')
  const origin = `${protocol}://${host}`
  const state = randomAuthState()
  createQQAuthAttempt({ userId: account.userId, method: 'mobile', verifier: state, payload: { state }, ttlMs: 10 * 60 * 1000 })
  const authorizeUrl = buildQQMobileAuthorizeUrl({
    callbackUrl: `${origin}/auth/mobile/callback`,
    state,
    useQQMusicRedirect: true,
  })

  redirect(authorizeUrl)
}
