import { NextResponse } from 'next/server'
import { getQQRecommendations, qqMusicErrorResponse } from '@/lib/qq'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function getPositiveInt(value: string | null, fallback: number, max: number) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const limit = getPositiveInt(searchParams.get('limit'), 30, 100)
  const cookie = request.headers.get('x-qq-music-cookie') ?? undefined

  try {
    return NextResponse.json(await getQQRecommendations({ cookie, limit }))
  } catch (error) {
    return qqMusicErrorResponse(error)
  }
}
