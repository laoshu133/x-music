import { NextResponse } from 'next/server'
import { listLocalFavorites, setLocalFavorite, setLocalFavoriteSynced } from '@/lib/db/favorites'
import { getQQFavoriteSongs, pullRemoteFavorites, QQMusicError, qqMusicErrorResponse, setQQFavoriteSong, syncPendingFavorites } from '@/lib/qq'
import type { MusicInfo } from '@/lib/types'
import { getCurrentAccount } from '@/lib/session'
import { pullEmbyFavorites, pushLocalFavoritesToEmby, syncEmbyFavoritesFromQQList, syncMappedEmbyFavoriteBestEffort } from '@/lib/emby/favorites'

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
  songId?: number | string
  songType?: number | string
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
  if (searchParams.get('remote') === 'emby' || (searchParams.get('sync') === 'pull' && searchParams.get('remote') === 'emby')) {
    const account = await getCurrentAccount()
    try {
      return NextResponse.json(await pullEmbyFavorites({
        account,
        limit: getPositiveInt(searchParams.get('limit'), 200, 500),
        syncQQ: searchParams.get('syncQQ') !== 'false',
      }))
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
    }
  }

  if (searchParams.get('remote') !== 'qq') {
    if (searchParams.get('sync') === 'pull') {
      try {
        return NextResponse.json(await pullRemoteFavorites({
          cookie: request.headers.get('x-qq-music-cookie') ?? undefined,
          page: getPositiveInt(searchParams.get('page'), 1, 1000),
          limit: getPositiveInt(searchParams.get('limit'), 100, 200),
        }))
      } catch (error) {
        return qqMusicErrorResponse(error)
      }
    }

    return NextResponse.json({
      source: 'local',
      list: listLocalFavorites(),
    })
  }

  const page = getPositiveInt(searchParams.get('page'), 1, 1000)
  const limit = getPositiveInt(searchParams.get('limit'), 50, 100)
  const cookie = request.headers.get('x-qq-music-cookie') ?? undefined

  try {
    const result = await getQQFavoriteSongs({ cookie, page, limit })
    const account = await getCurrentAccount()
    const embySync = await syncEmbyFavoritesFromQQList({
      account,
      qqFavorites: result.list,
      limit: getPositiveInt(searchParams.get('syncLimit'), 500, 1000),
    })
    return NextResponse.json({
      ...result,
      embySync,
    })
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
  const url = new URL(request.url)
  const cookie = body?.cookie ?? request.headers.get('x-qq-music-cookie') ?? undefined
  const account = await getCurrentAccount()
  if (url.searchParams.get('sync') === 'push') {
    if (url.searchParams.get('remote') === 'emby') {
      try {
        return NextResponse.json(await pushLocalFavoritesToEmby({
          account,
          limit: getPositiveInt(url.searchParams.get('limit'), 200, 500),
        }))
      } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
      }
    }

    try {
      return NextResponse.json(await syncPendingFavorites({
        cookie,
        limit: getPositiveInt(url.searchParams.get('limit'), 50, 200),
      }))
    } catch (error) {
      return qqMusicErrorResponse(error)
    }
  }

  if (!body?.songmid) return NextResponse.json({ error: 'Missing songmid' }, { status: 400 })

  if (url.searchParams.get('remote') !== 'qq') {
    const musicInfo = parseMusicInfo(body)
    if (!musicInfo) {
      return NextResponse.json({ error: 'Missing required local song fields' }, { status: 400 })
    }
    if (typeof body.favorite !== 'boolean') {
      return NextResponse.json({ error: 'Missing boolean favorite' }, { status: 400 })
    }

    let record = setLocalFavorite(musicInfo, body.favorite, account?.qqUin)
    let remoteSynced = false
    let remoteError: string | undefined
    let remotePayload: unknown
    let embySynced = false
    let embySyncAttempted = false
    let embyError: string | undefined
    try {
      await setQQFavoriteSong({
        cookie,
        songmid: musicInfo.songmid,
        favorited: body.favorite,
        songId: readFavoriteSongNumber(body, 'songId'),
        songType: readFavoriteSongNumber(body, 'songType'),
        raw: musicInfo.raw,
      })
      record = setLocalFavoriteSynced(musicInfo, body.favorite, account?.qqUin)
      remoteSynced = true
    } catch (error) {
      remoteError = error instanceof Error ? error.message : String(error)
      remotePayload = error instanceof QQMusicError ? error.payload : undefined
    }
    const embySync = await syncMappedEmbyFavoriteBestEffort(account, musicInfo, body.favorite)
    embySyncAttempted = embySync.attempted
    embySynced = embySync.synced
    embyError = embySync.error

    return NextResponse.json({
      source: 'local',
      favorite: record.desiredState === 'favorite',
      pending: record.syncState === 'pending',
      record,
      remoteSynced,
      remoteError,
      remotePayload,
      embySyncAttempted,
      embySynced,
      embyError,
    })
  }

  const favorited = resolveFavorited(body)
  if (favorited === undefined) {
    return NextResponse.json({ error: 'Missing favorited boolean or action add/remove' }, { status: 400 })
  }

  try {
    return NextResponse.json(await setQQFavoriteSong({
      cookie,
      songmid: body.songmid,
      favorited,
      songId: readFavoriteSongNumber(body, 'songId'),
      songType: readFavoriteSongNumber(body, 'songType'),
      raw: body.raw,
    }))
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
  const cookie = body.cookie ?? request.headers.get('x-qq-music-cookie') ?? undefined
  const account = await getCurrentAccount()
  if (url.searchParams.get('remote') !== 'qq') {
    const musicInfo = parseMusicInfo(body)
    if (!musicInfo) {
      return NextResponse.json({ error: 'Missing required local song fields' }, { status: 400 })
    }

    let record = setLocalFavorite(musicInfo, false, account?.qqUin)
    let remoteSynced = false
    let remoteError: string | undefined
    let remotePayload: unknown
    let embySynced = false
    let embySyncAttempted = false
    let embyError: string | undefined
    try {
      await setQQFavoriteSong({
        cookie,
        songmid: musicInfo.songmid,
        favorited: false,
        songId: readFavoriteSongNumber(body, 'songId'),
        songType: readFavoriteSongNumber(body, 'songType'),
        raw: musicInfo.raw,
      })
      record = setLocalFavoriteSynced(musicInfo, false, account?.qqUin)
      remoteSynced = true
    } catch (error) {
      remoteError = error instanceof Error ? error.message : String(error)
      remotePayload = error instanceof QQMusicError ? error.payload : undefined
    }
    const embySync = await syncMappedEmbyFavoriteBestEffort(account, musicInfo, false)
    embySyncAttempted = embySync.attempted
    embySynced = embySync.synced
    embyError = embySync.error

    return NextResponse.json({
      source: 'local',
      favorite: false,
      pending: record.syncState === 'pending',
      record,
      remoteSynced,
      remoteError,
      remotePayload,
      embySyncAttempted,
      embySynced,
      embyError,
    })
  }

  try {
    return NextResponse.json(await setQQFavoriteSong({
      cookie,
      songmid: body.songmid,
      favorited: false,
      songId: readFavoriteSongNumber(body, 'songId'),
      songType: readFavoriteSongNumber(body, 'songType'),
      raw: body.raw,
    }))
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

function readFavoriteSongNumber(input: FavoriteRequest, key: 'songId' | 'songType'): number | undefined {
  const direct = parseFiniteNumber(input[key])
  if (direct !== undefined) return direct
  if (!input.raw || typeof input.raw !== 'object') return undefined

  const raw = input.raw as Record<string, unknown>
  const aliases = key === 'songId'
    ? ['songId', 'songid', 'song_id', 'id']
    : ['songType', 'songtype', 'song_type', 'type']

  for (const alias of aliases) {
    const parsed = parseFiniteNumber(raw[alias])
    if (parsed !== undefined) return parsed
  }

  return undefined
}

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}
