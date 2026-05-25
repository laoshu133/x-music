import { NextResponse } from 'next/server'
import { getFavoriteStatus } from '@/lib/db/favorites'
import { getAccountByQQ } from '@/lib/db/accounts'
import { getStoredQQLoginState } from '@/lib/db/qq-session'
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
  const { searchParams } = new URL(request.url)
  const source = searchParams.get('source')
  const songmid = searchParams.get('songmid')

  if (source || songmid) {
    if (source !== 'tx' || !songmid) {
      return NextResponse.json({ error: 'Missing source or songmid' }, { status: 400 })
    }
    return NextResponse.json(getFavoriteStatus(source as OnlineSource, songmid))
  }

  try {
    const account = await getCurrentAccountForFavoriteStatus()
    const qq = await getQQFavoriteSongs({
      cookie: request.headers.get('x-qq-music-cookie') ?? account?.qqCookie,
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
  const cookie = request.headers.get('x-qq-music-cookie') ?? undefined
  const account = await getCurrentAccountForFavoriteStatus()

  if (!account) {
    return NextResponse.json({ error: 'Not logged in' }, { status: 401 })
  }

  try {
    const qq = await readQQFavorites({
      cookie: cookie ?? account.qqCookie,
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

async function getCurrentAccountForFavoriteStatus() {
  try {
    return await getCurrentAccount()
  } catch (error) {
    if (
      process.env.NODE_ENV !== 'test'
      || !String(error instanceof Error ? error.message : error).includes('outside a request scope')
    ) {
      throw error
    }
    const stored = getStoredQQLoginState()
    return stored ? getAccountByQQ(stored.uin) : undefined
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
