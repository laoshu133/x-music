import { NextResponse } from 'next/server'
import { searchQQPlaylists } from '@/lib/qq'

export const runtime = 'nodejs'

function getPositiveInt(value: string | null, fallback: number, max: number) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const query = searchParams.get('q')?.trim() ?? ''
  if (!query) {
    return NextResponse.json({ error: 'Missing q' }, { status: 400 })
  }

  const page = getPositiveInt(searchParams.get('page'), 1, 1000)
  const limit = getPositiveInt(searchParams.get('limit'), 20, 100)
  const result = await searchQQPlaylists(query, page, limit)
  return NextResponse.json(result)
}
