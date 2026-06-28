import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { buildQQMobileAuthorizeUrl, randomAuthState } from '@/lib/qq/mobile-auth'

export const dynamic = 'force-dynamic'

export async function GET() {
  const headerList = await headers()
  const host = headerList.get('x-forwarded-host') ?? headerList.get('host') ?? 'localhost:3004'
  const protocol = headerList.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https')
  const origin = `${protocol}://${host}`
  const authorizeUrl = buildQQMobileAuthorizeUrl({
    callbackUrl: `${origin}/auth/mobile/callback`,
    state: randomAuthState(),
    useQQMusicRedirect: true,
  })

  redirect(authorizeUrl)
}
