import { NextResponse } from 'next/server'
import { getQQToplistDetail } from '@/lib/qq'

export const runtime = 'nodejs'

function getPositiveInt(value: string | null, fallback: number, max: number) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const { searchParams } = new URL(request.url)
  const page = getPositiveInt(searchParams.get('page'), 1, 1000)
  const limit = getPositiveInt(searchParams.get('limit'), 100, 300)
  const result = await getQQToplistDetail(id, page, limit)
  return NextResponse.json(result)
}
