import { NextResponse } from 'next/server'
import { getQQUserPlaylists, qqMusicErrorResponse } from '@/lib/qq'

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
  const { searchParams } = new URL(request.url)
  try {
    return NextResponse.json(await getQQUserPlaylists({
      uin: searchParams.get('uin') ?? undefined,
      cookie: request.headers.get('x-qq-music-cookie') ?? undefined,
      offset: getNonNegativeInt(searchParams.get('offset'), 0, 10000),
      limit: getPositiveInt(searchParams.get('limit'), 30, 100),
    }))
  } catch (error) {
    return qqMusicErrorResponse(error)
  }
}
