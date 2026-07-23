import { NextResponse } from 'next/server'
import { getQQUserPlaylists, qqMusicErrorResponse } from '@/lib/qq'
import { isAuthResponse, requireUserAccount } from '@/lib/api-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function getNonNegativeInt(value: string | null, fallback: number, max: number) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.min(parsed, max)
}

function getPositiveInt(value: string | null, fallback: number, max: number) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

export async function GET(request: Request) {
  const account = await requireUserAccount()
  if (isAuthResponse(account)) return account
  const { searchParams } = new URL(request.url)
  try {
    return NextResponse.json(await getQQUserPlaylists({
      uin: account.qqUin,
      cookie: account.qqCookie,
      offset: getNonNegativeInt(searchParams.get('offset'), 0, 10000),
      limit: getPositiveInt(searchParams.get('limit'), 30, 100),
    }))
  } catch (error) {
    return qqMusicErrorResponse(error)
  }
}
