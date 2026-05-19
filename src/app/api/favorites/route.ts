import { NextResponse } from 'next/server'
import { listLocalFavorites, setLocalFavorite } from '@/lib/db/favorites'
import { getQQFavoriteSongs, qqMusicErrorResponse, setQQFavoriteSong } from '@/lib/qq'
import type { MusicInfo } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type FavoriteRequest = {
  cookie?: string
  songmid?: string
  source?: string
  name?: string
  singer?: string
  albumName?: string
  albumId?: string
  interval?: string
  img?: string
  raw?: unknown
  favorite?: boolean
  favorited?: boolean
  action?: 'add' | 'remove' | 'favorite' | 'unfavorite'
}

function getPositiveInt(value: string | null, fallback: number, max: number) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

function resolveFavorited(body: FavoriteRequest) {
  if (typeof body.favorite === 'boolean') return body.favorite
  if (typeof body.favorited === 'boolean') return body.favorited
  if (body.action === 'add' || body.action === 'favorite') return true
  if (body.action === 'remove' || body.action === 'unfavorite') return false
  return undefined
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  if (searchParams.get('remote') !== 'qq') {
    return NextResponse.json({
      source: 'local',
      list: listLocalFavorites(),
    })
  }

  const page = getPositiveInt(searchParams.get('page'), 1, 1000)
  const limit = getPositiveInt(searchParams.get('limit'), 50, 100)
  const cookie = request.headers.get('x-qq-music-cookie') ?? undefined

  try {
    return NextResponse.json(await getQQFavoriteSongs({ cookie, page, limit }))
  } catch (error) {
    return qqMusicErrorResponse(error)
  }
}

export async function POST(request: Request) {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return NextResponse.json({ error: 'POST /api/favorites expects application/json' }, { status: 415 })
  }

  const body = (await request.json().catch(() => undefined)) as FavoriteRequest | undefined
  if (!body?.songmid) return NextResponse.json({ error: 'Missing songmid' }, { status: 400 })

  const url = new URL(request.url)
  if (url.searchParams.get('remote') !== 'qq') {
    const musicInfo = parseMusicInfo(body)
    if (!musicInfo) {
      return NextResponse.json({ error: 'Missing required local song fields' }, { status: 400 })
    }
    if (typeof body.favorite !== 'boolean') {
      return NextResponse.json({ error: 'Missing boolean favorite' }, { status: 400 })
    }

    const record = setLocalFavorite(musicInfo, body.favorite)
    return NextResponse.json({
      source: 'local',
      favorite: record.desiredState === 'favorite',
      pending: record.syncState === 'pending',
      record,
    })
  }

  const favorited = resolveFavorited(body)
  if (favorited === undefined) {
    return NextResponse.json({ error: 'Missing favorited boolean or action add/remove' }, { status: 400 })
  }

  try {
    return NextResponse.json(await setQQFavoriteSong({ cookie: body.cookie, songmid: body.songmid, favorited }))
  } catch (error) {
    return qqMusicErrorResponse(error)
  }
}

export async function DELETE(request: Request) {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return NextResponse.json({ error: 'DELETE /api/favorites expects application/json' }, { status: 415 })
  }

  const body = (await request.json().catch(() => undefined)) as FavoriteRequest | undefined
  if (!body?.songmid) return NextResponse.json({ error: 'Missing songmid' }, { status: 400 })

  const url = new URL(request.url)
  if (url.searchParams.get('remote') !== 'qq') {
    const musicInfo = parseMusicInfo(body)
    if (!musicInfo) {
      return NextResponse.json({ error: 'Missing required local song fields' }, { status: 400 })
    }

    const record = setLocalFavorite(musicInfo, false)
    return NextResponse.json({
      source: 'local',
      favorite: false,
      pending: record.syncState === 'pending',
      record,
    })
  }

  try {
    return NextResponse.json(await setQQFavoriteSong({ cookie: body.cookie, songmid: body.songmid, favorited: false }))
  } catch (error) {
    return qqMusicErrorResponse(error)
  }
}

const parseMusicInfo = (input: FavoriteRequest): MusicInfo | undefined => {
  if (input.source !== 'tx') return undefined
  if (!isNonEmptyString(input.songmid) || !isNonEmptyString(input.name) || !isNonEmptyString(input.singer)) return undefined

  return {
    source: input.source,
    songmid: input.songmid,
    name: input.name,
    singer: input.singer,
    albumName: normalizeOptional(input.albumName),
    albumId: normalizeOptional(input.albumId),
    interval: normalizeOptional(input.interval),
    img: normalizeOptional(input.img),
    raw: input.raw ?? input,
  }
}

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === 'string' && value.trim().length > 0
}

const normalizeOptional = (value: unknown): string | undefined => {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
