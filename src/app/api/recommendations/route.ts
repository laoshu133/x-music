import { NextResponse } from 'next/server'
import { getQQDailyRecommendations, getQQRecommendationsForAccount, qqMusicErrorResponse } from '@/lib/qq'
import { isAuthResponse, requireUserAccount } from '@/lib/api-auth'
import { QQAuthExpiredError, qqAuthExpiredResponse } from '@/lib/qq/auth-state'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function getPositiveInt(value: string | null, fallback: number, max: number) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

export async function GET(request: Request) {
  const account = await requireUserAccount()
  if (isAuthResponse(account)) return account
  const { searchParams } = new URL(request.url)
  const limit = getPositiveInt(searchParams.get('limit'), 20, 20)
  const cookie = account.qqCookie
  const type = searchParams.get('type')?.toLowerCase()

  try {
    if (type === 'daily') {
      return NextResponse.json(await getQQDailyRecommendations({ cookie, limit }))
    }
    return NextResponse.json(await getQQRecommendationsForAccount(account, { limit }))
  } catch (error) {
    if (error instanceof QQAuthExpiredError) return qqAuthExpiredResponse(error)
    return qqMusicErrorResponse(error)
  }
}
