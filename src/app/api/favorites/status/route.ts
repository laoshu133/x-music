import { NextResponse } from 'next/server'
import { getFavoriteStatus } from '@/lib/db/favorites'
import type { OnlineSource } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const source = searchParams.get('source')
  const songmid = searchParams.get('songmid')

  if (source !== 'tx' || !songmid) {
    return NextResponse.json({ error: 'Missing source or songmid' }, { status: 400 })
  }

  return NextResponse.json(getFavoriteStatus(source as OnlineSource, songmid))
}
