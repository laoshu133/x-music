import { NextResponse } from 'next/server'
import { getFavoriteStatus } from '@/lib/db/favorites'
import { getCurrentAccount } from '@/lib/session'
import { getQQFavoriteSongs, qqMusicErrorResponse } from '@/lib/qq'
import { getEmbyFavoriteCount, syncEmbyFavoritesFromQQFavorites } from '@/lib/emby/favorites'
import type { MusicInfo, OnlineSource } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function getPositiveInt(value: string | null, fallback: number, max: number) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

export async function GET(request: Request) {
  const account = await getCurrentAccount()
  if (!account) return NextResponse.json({ error: 'Login required', code: 'AUTH_REQUIRED' }, { status: 401 })
  const { searchParams } = new URL(request.url)
  const source = searchParams.get('source')
  const songmid = searchParams.get('songmid')

  if (source || songmid) {
    if (source !== 'tx' || !songmid) {
      return NextResponse.json({ error: 'Missing source or songmid' }, { status: 400 })
    }
    return NextResponse.json(getFavoriteStatus(source as OnlineSource, songmid, account.userId))
  }

  try {
    const qq = await getQQFavoriteSongs({
      cookie: account.qqCookie,
      page: 1,
      limit: getPositiveInt(searchParams.get('limit'), 50, 100),
    })
    const embyTotal = await getEmbyFavoriteCount({ account })

    return NextResponse.json({
      qqTotal: qq.total,
      embyTotal,
    })
  } catch (error) {
    return qqMusicErrorResponse(error)
  }
}

export async function POST(request: Request) {
  const url = new URL(request.url)
  const account = await getCurrentAccount()

  if (!account) {
    return NextResponse.json({ error: 'Not logged in' }, { status: 401 })
  }

  try {
    const qq = await readQQFavorites({
      cookie: account.qqCookie,
      limit: getPositiveInt(url.searchParams.get('limit'), 5000, 5000),
    })
    const embySync = await syncEmbyFavoritesFromQQFavorites({
      account,
      qqFavorites: qq.list,
      limit: getPositiveInt(url.searchParams.get('syncLimit'), 5000, 5000),
    })

    return NextResponse.json({
      qqTotal: qq.total,
      embyTotal: embySync.afterEmbyTotal,
      changed: embySync.synced,
      skipped: embySync.skipped,
      failed: embySync.failed,
      sync: embySync,
    })
  } catch (error) {
    return qqMusicErrorResponse(error)
  }
}

async function readQQFavorites(input: {
  cookie?: string
  limit: number
}): Promise<{
  list: MusicInfo[]
  total: number
}> {
  const pageSize = Math.min(input.limit, 100)
  const first = await getQQFavoriteSongs({ cookie: input.cookie, page: 1, limit: pageSize })
  const list = [...first.list]
  const total = first.total
  const maxPages = Math.min(Math.ceil(total / pageSize), Math.ceil(input.limit / pageSize))

  for (let page = 2; page <= maxPages; page += 1) {
    const result = await getQQFavoriteSongs({ cookie: input.cookie, page, limit: pageSize })
    list.push(...result.list)
    if (result.list.length < pageSize) break
  }

  return {
    list,
    total,
  }
}
