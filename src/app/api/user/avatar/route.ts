import { NextResponse } from 'next/server'
import { getQQUserAvatar, qqMusicErrorResponse } from '@/lib/qq'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const size = Number.parseInt(searchParams.get('size') ?? '140', 10)

  try {
    return NextResponse.json(getQQUserAvatar({
      k: searchParams.get('k') ?? undefined,
      uin: searchParams.get('uin') ?? undefined,
      size,
    }))
  } catch (error) {
    return qqMusicErrorResponse(error)
  }
}
