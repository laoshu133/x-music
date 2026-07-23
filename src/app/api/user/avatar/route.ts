import { NextResponse } from 'next/server'
import { getQQUserAvatar, qqMusicErrorResponse } from '@/lib/qq'
import { isAuthResponse, requireUserAccount } from '@/lib/api-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const account = await requireUserAccount()
  if (isAuthResponse(account)) return account
  const { searchParams } = new URL(request.url)
  const size = Number.parseInt(searchParams.get('size') ?? '140', 10)

  try {
    return NextResponse.json(getQQUserAvatar({
      uin: account.qqUin,
      size,
    }))
  } catch (error) {
    return qqMusicErrorResponse(error)
  }
}
