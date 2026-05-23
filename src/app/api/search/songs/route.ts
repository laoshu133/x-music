import { NextResponse } from 'next/server'
import { searchQQMusic } from '@/lib/qq'
import { logCompletedRequest, logFailedRequest } from '@/lib/request-log'

export const runtime = 'nodejs'

function getPositiveInt(value: string | null, fallback: number, max: number) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

export async function GET(request: Request) {
  const startedAt = Date.now()
  const { searchParams } = new URL(request.url)
  const query = searchParams.get('q')?.trim() ?? ''
  if (!query) {
    return NextResponse.json({ error: 'Missing q' }, { status: 400 })
  }

  const page = getPositiveInt(searchParams.get('page'), 1, 1000)
  const limit = getPositiveInt(searchParams.get('limit'), 30, 50)
  try {
    const result = await searchQQMusic(query, page, limit)
    const response = NextResponse.json(result)
    response.headers.set('Server-Timing', `qq-search;dur=${Math.max(0, Date.now() - startedAt)}`)
    return logCompletedRequest(request, response, startedAt, {
      route: '/api/search/songs',
      queryLength: query.length,
      page,
      limit,
      resultCount: result.list.length,
      total: result.total,
    })
  } catch (error) {
    logFailedRequest(request, startedAt, error, {
      route: '/api/search/songs',
      queryLength: query.length,
      page,
      limit,
    })
    throw error
  }
}
