import { ensureTrack, getPlayableTrackFile, getTrack, hasActiveTrackFile, insertPlayEvent, listPlayHistory, upsertTrackFileStatus } from '@/lib/cache/store'
import { cachedResourceResponse } from '@/lib/cache/resources'
import { createUpstreamTeeResponse, streamLocalFile } from '@/lib/cache/stream'
import { encryptedQQAudioRequiresKeyMessage, isEncryptedQQAudioFileName, isEncryptedQQAudioRequiresKeyError } from '@/lib/cache/decrypt'
import { db } from '@/lib/db'
import { MusicUrlConfigError, MusicUrlResolveError, qualityFallbacks, resolveMusicUrl, resolveMusicUrlWithFallback } from '@/lib/music-url/resolve'
import { isHighestAvailableQuality } from '@/lib/quality'
import {
  getQQPlaylistDetail,
  getQQFavoriteSongs,
  getQQDailyRecommendations,
  getQQLoginState,
  getQQLyrics,
  getQQRecommendations,
  getQQSongDetail,
  getQQUserPlaylists,
  searchQQMusic,
  searchQQPlaylists,
  setQQFavoriteSong,
  syncQQPlayHistoryBestEffort,
} from '@/lib/qq'
import { getFavoriteStatusForAccount, listLocalFavoritesForAccount, setLocalFavorite, setLocalFavoriteSynced } from '@/lib/db/favorites'
import type { MusicInfo, MusicQuality, PlayHistoryRecord, QQPlaylistInfo, TrackRecord } from '@/lib/types'
import { enqueueEmbyTrackSync } from './sync'
import { hasEmbySyncableCachedMedia } from './sync-worker'
import { logServiceEvent, markRequestSource, safeRequestPath } from '@/lib/request-log'
import { albumVirtualId, decodeVirtualId, encodeVirtualId, genreVirtualId, playlistVirtualId, songVirtualId, type VirtualId } from './virtual-ids'
import {
  forgetVirtualAlbum,
  forgetVirtualPlaylist,
  forgetVirtualSong,
  loadVirtualAlbumSongs,
  listVirtualSongs,
  loadVirtualPlaylist,
  loadVirtualSong,
  rememberVirtualAlbumSongs,
  rememberVirtualPlaylist,
  rememberVirtualSong,
} from './virtual-store'
import { deleteRemoteMapping, getRemoteMapping, getRemoteMappingByRemote, upsertRemoteMapping, type RemoteMappingRecord } from '@/lib/db/remote-mappings'
import { deleteEmbyItems, fetchEmbyJson, fetchEmbyText, searchEmbyAudioByName, searchEmbyPlaylistByName } from './upstream-api'
import { proxyToUpstreamEmby } from './upstream-proxy'
import { ensureEmbyMasterCachedBestEffort } from './master'
import { getAccountByEmbyUsername, getAccountByEmbyUserId, getAccountByQQ, listAccounts, markAccountActive, markAccountLogin, type AccountRecord } from '@/lib/db/accounts'
import { ensureUpstreamEmbyUserForAccount, getDefaultUpstreamMusicLibraryId } from './auth'
import { syncMappedEmbyFavoriteBestEffort } from './favorites'
import {
  extractFavoriteItemId,
  extractImageItemId,
  extractItemId,
  extractNestedItemId,
  extractPlaylistId,
  extractSubtitleItemId,
  isAudioRequest,
  isFavoriteItemMutation,
  isGenresCollectionPath,
  isImageRequest,
  isItemRequest,
  isItemsDeleteRequest,
  isItemsRequest,
  isLyricsRequest,
  isPlaybackInfoRequest,
  isPlaybackReportRequest,
  isPlaylistItemsRequest,
  isSimilarItemsRequest,
  isSubsonicGetSongRequest,
  isSubsonicLyricsRequest,
  isSubtitleStreamRequest,
  isUserRequest,
  isUserViewsRequest,
} from './local-route-patterns'
import crypto from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createLocalAccessToken } from './tokens'
import { readClientAccessToken } from './client-compat'
import { readRequestIp } from '@/lib/request-ip'
import fs from 'node:fs'

const LOCAL_SERVER_ID = 'x-music'
const MUSIC_LIBRARY_ID = 'x-music-music'
const MAX_EMBY_LIST_LIMIT = 1000
const QQ_SONG_PAGE_SIZE = 100
const QQ_SEARCH_SONG_PAGE_SIZE = 50
const QQ_PLAYLIST_PAGE_SIZE = 50
const QQ_FAVORITES_MAX_CONCURRENCY = 4
const QQ_FAVORITES_DEFAULT_TOTAL = 999
const MAX_EMBY_SEARCH_VIRTUAL_ITEMS = 50
const VIRTUAL_RECOMMENDATION_PLAYLIST_PLAY_COUNT = '999999999'
const QQ_FAVORITE_ORDER_BASE_MS = Date.UTC(2099, 0, 1)
const FAVORITE_SORT_TIME = Symbol('favoriteSortTime')

type PageParams = {
  startIndex: number
  limit?: number
}

type WindowResult<T> = {
  items: T[]
  total: number
  totalReliable?: boolean
  rawCount?: number
  complete?: boolean
}

type TimedResult<T> = {
  result: T
  durationMs: number
}

type LocalRouteContext = {
  request: Request
  embyPath: string
}

type LocalRoute = {
  name: string
  authorize?: boolean
  match: (context: LocalRouteContext) => boolean
  handle: (context: LocalRouteContext) => Response | Promise<Response | undefined> | undefined
}

type MatchedLocalRoute = {
  route: LocalRoute
  context: LocalRouteContext
}

const favoriteTotalCache = new Map<string, number>()

const LOCAL_ROUTES: LocalRoute[] = [
  {
    name: 'public-system-info',
    match: ({ request, embyPath }) => request.method === 'GET' && pathEquals(embyPath, '/System/Info/Public'),
    handle: () => Response.json({
      LocalAddress: '',
      ServerName: 'XMusic',
      Version: '0.1.0',
      ProductName: 'XMusic Emby Gateway',
      Id: LOCAL_SERVER_ID,
      StartupWizardCompleted: true,
    }),
  },
  {
    name: 'authenticate-by-name',
    match: ({ request, embyPath }) => request.method === 'POST' && pathEquals(embyPath, '/Users/AuthenticateByName'),
    handle: ({ request }) => handleAuthenticateByName(request),
  },
  {
    name: 'public-users',
    match: ({ request, embyPath }) => request.method === 'GET' && pathEquals(embyPath, '/Users/Public'),
    handle: () => handlePublicUsers(),
  },
  {
    name: 'system-endpoint',
    match: ({ request, embyPath }) => request.method === 'GET' && pathEquals(embyPath, '/System/Endpoint'),
    handle: () => Response.json({ IsLocal: true, IsInNetwork: true }),
  },
  {
    name: 'delete-items',
    authorize: true,
    match: ({ request, embyPath }) => isItemsDeleteRequest(request.method, embyPath),
    handle: ({ request, embyPath }) => handleItemsDeleteRequest(request, embyPath),
  },
  {
    name: 'favorite-item-mutation',
    authorize: true,
    match: ({ request, embyPath }) => isFavoriteItemMutation(request.method, embyPath)
      && isLocallyHandledFavoriteItemMutation(embyPath),
    handle: ({ request, embyPath }) => handleFavoriteItemMutationRequest(
      request,
      extractFavoriteItemId(embyPath)!,
      favoriteItemMutationState(request, embyPath),
    ),
  },
  {
    name: 'user',
    authorize: true,
    match: ({ request, embyPath }) => request.method === 'GET' && isUserRequest(embyPath),
    handle: ({ request, embyPath }) => handleUserRequest(request, embyPath),
  },
  {
    name: 'user-views',
    authorize: true,
    match: ({ request, embyPath }) => request.method === 'GET' && isUserViewsRequest(embyPath),
    handle: ({ embyPath }) => handleUserViewsRequest(embyPath),
  },
  {
    name: 'health',
    match: ({ request, embyPath }) => request.method === 'GET' && pathEquals(embyPath, '/x-music/health'),
    handle: () => Response.json({ ok: true, service: 'x-music-emby-gateway' }),
  },
  {
    name: 'narjo-no-lyrics-probe',
    match: ({ request, embyPath }) => request.method === 'GET' && pathEquals(embyPath, '/emby-no-lyrics-api'),
    handle: () => markRequestSource(new Response(null, { status: 204 }), 'local'),
  },
  {
    name: 'playback-report',
    authorize: true,
    match: ({ request, embyPath }) => request.method === 'POST' && isPlaybackReportRequest(embyPath),
    handle: ({ request, embyPath }) => handlePlaybackReportRequest(request, embyPath),
  },
  {
    name: 'local-empty-collection',
    authorize: true,
    match: ({ request, embyPath }) => request.method === 'GET' && isLocalEmptyCollectionRequest(embyPath),
    handle: ({ request, embyPath }) => handleCollectionRequest(request, embyPath),
  },
  {
    name: 'image',
    match: ({ request, embyPath }) => request.method === 'GET' && isImageRequest(embyPath),
    handle: ({ request, embyPath }) => handleImageRequest(request, embyPath),
  },
  {
    name: 'subtitle-stream',
    authorize: true,
    match: ({ request, embyPath }) => (request.method === 'GET' || request.method === 'HEAD') && isSubtitleStreamRequest(embyPath),
    handle: ({ request, embyPath }) => handleSubtitleStreamRequest(request, embyPath),
  },
  {
    name: 'item',
    authorize: true,
    match: ({ request, embyPath }) => request.method === 'GET' && isItemRequest(embyPath),
    handle: ({ request, embyPath }) => handleItemRequest(request, embyPath),
  },
  {
    name: 'playback-info',
    authorize: true,
    match: ({ request, embyPath }) => (request.method === 'GET' || request.method === 'POST') && isPlaybackInfoRequest(embyPath),
    handle: ({ embyPath }) => handlePlaybackInfoRequest(embyPath),
  },
  {
    name: 'similar-items',
    authorize: true,
    match: ({ request, embyPath }) => request.method === 'GET' && isSimilarItemsRequest(embyPath),
    handle: ({ request, embyPath }) => handleSimilarItemsRequest(request, embyPath),
  },
  {
    name: 'lyrics',
    match: ({ request, embyPath }) => request.method === 'GET' && isLyricsRequest(embyPath),
    handle: ({ request, embyPath }) => handleLyricsRequest(request, embyPath),
  },
  {
    name: 'subsonic-get-song',
    match: ({ request, embyPath }) => request.method === 'GET' && isSubsonicGetSongRequest(embyPath),
    handle: ({ request }) => handleSubsonicGetSongRequest(request),
  },
  {
    name: 'subsonic-lyrics',
    match: ({ request, embyPath }) => request.method === 'GET' && isSubsonicLyricsRequest(embyPath),
    handle: ({ request }) => handleSubsonicLyricsRequest(request),
  },
  {
    name: 'items',
    authorize: true,
    match: ({ request, embyPath }) => request.method === 'GET' && isItemsRequest(embyPath),
    handle: ({ request, embyPath }) => handleItemsRequest(request, embyPath),
  },
  {
    name: 'playlist-items',
    authorize: true,
    match: ({ request, embyPath }) => request.method === 'GET' && isPlaylistItemsRequest(embyPath),
    handle: ({ request, embyPath }) => handlePlaylistItemsRequest(request, embyPath),
  },
  {
    name: 'audio',
    authorize: true,
    match: ({ request, embyPath }) => (request.method === 'GET' || request.method === 'HEAD') && isAudioRequest(embyPath),
    handle: ({ request, embyPath }) => handleAudioRequest(request, embyPath),
  },
]

export async function handleLocalEmbyRequest(request: Request, embyPath: string): Promise<Response | undefined> {
  const matched = matchLocalRoute({ request, embyPath })
  if (!matched) return undefined
  const { route, context } = matched
  if (route.authorize && !isAuthorizedLocalRequest(request)) return unauthorizedResponse()
  return route.handle(context)
}

function matchLocalRoute(context: LocalRouteContext): MatchedLocalRoute | undefined {
  const route = LOCAL_ROUTES.find(candidate => candidate.match(context))
  return route ? { route, context } : undefined
}

async function handleAuthenticateByName(request: Request): Promise<Response> {
  const credentials = await readAuthenticateCredentials(request)
  const username = credentials.username.trim()
  const password = credentials.password
  const account = getAccountByEmbyUsername(username)
  if (!account || password !== account.embyPassword) {
    return Response.json({ error: 'Invalid username or password' }, { status: 401 })
  }

  if (account.embyUserId && process.env.NODE_ENV === 'test') {
    const accessToken = createLocalAccessToken(account)
    markAccountLogin(account.qqUin, readRequestIp(request))
    return localAuthenticateResponse(account, accessToken)
  }

  const upstreamAccount = await ensureUpstreamEmbyUserForAccount(account).catch((error: unknown) => {
    console.error(`Upstream Emby account binding failed for ${account.embyUsername}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  })
  if (!upstreamAccount) {
    return Response.json({
      error: 'Upstream Emby account binding failed',
      actionable: 'Check EMBY_UPSTREAM_URL, EMBY_API_KEY, and whether a music library exists in upstream Emby.',
    }, { status: 502 })
  }
  const accessToken = createLocalAccessToken(upstreamAccount)
  markAccountLogin(upstreamAccount.qqUin, readRequestIp(request))
  return localAuthenticateResponse(upstreamAccount, accessToken)
}

async function readAuthenticateCredentials(request: Request): Promise<{ username: string; password: string }> {
  const body = await readRequestBodyValues(request)
  return {
    username: readFirstString(body, ['Username', 'username', 'UserName', 'Name', 'name']),
    password: readFirstString(body, ['Pw', 'pw', 'Password', 'password']),
  }
}

async function readRequestBodyValues(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries((await request.formData().catch(() => new FormData())).entries())
  }
  if (contentType.includes('multipart/form-data')) {
    return Object.fromEntries((await request.formData().catch(() => new FormData())).entries())
  }
  const parsed = await request.json().catch(() => undefined) as unknown
  return isObject(parsed) ? parsed : {}
}

function readFirstString(values: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = values[key]
    if (typeof value === 'string') return value
  }
  return ''
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function localAuthenticateResponse(account: AccountRecord, accessToken: string): Response {
  return Response.json({
    User: {
      Name: account.embyUsername,
      ServerId: LOCAL_SERVER_ID,
      Id: localUserId(account),
      HasPassword: true,
      HasConfiguredPassword: true,
      HasConfiguredEasyPassword: false,
      EnableAutoLogin: false,
      Policy: {
        IsAdministrator: false,
        IsHidden: false,
        IsDisabled: false,
        EnableRemoteControlOfOtherUsers: false,
        EnableSharedDeviceControl: false,
        EnableRemoteAccess: true,
      },
    },
    SessionInfo: {},
    AccessToken: accessToken,
    ServerId: LOCAL_SERVER_ID,
  })
}

function authorizedLocalAccount(request: Request): AccountRecord | undefined {
  const token = readClientAccessToken(request)
  if (!token) return undefined
  const account = listAccounts().find(account => token === createLocalAccessToken(account))
  if (account) markAccountActive(account.qqUin)
  return account
}

function subsonicAccountForRequest(request: Request): AccountRecord | undefined {
  const username = new URL(request.url).searchParams.get('u')?.trim()
  if (!username) return undefined
  const account = getAccountByEmbyUsername(username) ?? getAccountByQQ(username.replace(/^QQ/i, ''))
  if (account) markAccountActive(account.qqUin)
  return account
}

function isAuthorizedLocalRequest(request: Request): boolean {
  return Boolean(authorizedLocalAccount(request))
}

function unauthorizedResponse(): Response {
  return Response.json({ error: 'Unauthorized' }, { status: 401 })
}

function pathEquals(path: string, expected: string): boolean {
  return path.toLowerCase() === expected.toLowerCase()
}

function localUserId(account: AccountRecord): string {
  return account.embyUserId ?? crypto.createHash('sha1').update(`${LOCAL_SERVER_ID}:${account.qqUin}:${account.embyUsername}`).digest('hex')
}

function handlePublicUsers(): Response {
  return Response.json(listAccounts().map(localUser))
}

async function handleItemsDeleteRequest(request: Request, embyPath: string): Promise<Response> {
  const ids = deleteRequestIds(request, embyPath)
  if (ids.length === 0) {
    return Response.json({ error: 'Missing item ids' }, { status: 400 })
  }

  const upstreamIds: string[] = []
  for (const id of ids) {
    const decoded = decodeVirtualId(id)
    if (decoded) {
      forgetVirtualItem(decoded)
    } else {
      upstreamIds.push(id)
    }
  }

  try {
    await deleteEmbyItems(upstreamIds, { token: authorizedLocalAccount(request)?.embyAccessToken })
  } catch (error) {
    return embyDeleteFailureResponse(error)
  }

  return new Response(null, { status: 204 })
}

function embyDeleteFailureResponse(error: unknown): Response {
  const detail = error instanceof Error ? error.message : String(error)
  return Response.json({
    error: '无法删除 Emby 歌单',
    message: '上游 Emby 拒绝了删除请求，歌单没有被删除。',
    detail,
    actionable: '请确认当前 Emby 用户有删除权限，歌单所在媒体库允许删除内容；如果刚调整过权限，请重新登录后再试。',
  }, { status: 502 })
}

function deleteRequestIds(request: Request, embyPath: string): string[] {
  if (request.method === 'DELETE') {
    const itemId = extractItemId(embyPath)
    return itemId ? [itemId] : []
  }
  const url = new URL(request.url)
  const raw = url.searchParams.get('Ids') ?? url.searchParams.get('ids') ?? ''
  return raw.split(',').map(id => id.trim()).filter(Boolean)
}

function forgetVirtualItem(decoded: VirtualId): void {
  if (decoded.kind === 'qq-song') {
    forgetVirtualSong(decoded.songmid)
  } else if (decoded.kind === 'qq-playlist') {
    forgetVirtualPlaylist(decoded.id)
  } else if (decoded.kind === 'qq-album') {
    forgetVirtualAlbum(decoded.id)
  }
}

async function handleFavoriteItemMutationRequest(request: Request, itemId: string, favorite: boolean): Promise<Response> {
  const decoded = await resolveSongVirtualId(itemId)
  if (!decoded) return favoriteItemMutationResponse(itemId, favorite)

  if (decoded.kind !== 'qq-song') {
    return favoriteItemMutationResponse(itemId, favorite)
  }

  const loaded = favorite
    ? await loadOrFetchVirtualSong(decoded.songmid, decoded.playlistId)
    : loadVirtualSong(decoded.songmid)
  if (!loaded) {
    if (!favorite) {
      const tracked = getTrack('tx', decoded.songmid)
      if (tracked) {
        const account = authorizedLocalAccount(request)
        const song = trackRecordToMusicInfo(tracked)
        setLocalFavorite(song, false, account?.qqUin)
        await syncMappedEmbyFavoriteBestEffort(account, song, false)
      }
      return favoriteItemMutationResponse(itemId, false)
    }
    return Response.json({ error: 'Virtual song not found' }, { status: 404 })
  }

  const account = authorizedLocalAccount(request)
  setLocalFavorite(loaded.song, favorite, account?.qqUin)

  try {
    await setQQFavoriteSong({
      cookie: qqCookieForRequest(request),
      songmid: loaded.song.songmid,
      favorited: favorite,
      raw: loaded.song.raw,
    })
    setLocalFavoriteSynced(loaded.song, favorite, account?.qqUin)
  } catch (error) {
    console.warn(
      `QQ favorite ${favorite ? 'add' : 'remove'} sync deferred for ${loaded.song.songmid}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  await syncMappedEmbyFavoriteBestEffort(account, loaded.song, favorite)

  return favoriteItemMutationResponse(itemId, favorite)
}

function favoriteItemMutationResponse(itemId: string, favorite: boolean): Response {
  return Response.json({
    PlaybackPositionTicks: 0,
    PlayCount: 0,
    IsFavorite: favorite,
    Played: false,
    Key: itemId,
    ItemId: itemId,
    ServerId: LOCAL_SERVER_ID,
  })
}

function getMappedSongmidForEmbyItemId(itemId: string): string | undefined {
  const mapping = getRemoteMappingByRemote({ remote: 'emby', remoteId: itemId })
  if (mapping?.localType !== 'track') return undefined
  return mapping.localKey.match(/^tx:(.+)$/)?.[1]
}

function favoriteItemMutationState(request: Request, path: string): boolean {
  if (request.method === 'DELETE') return false
  return !/\/Delete$/i.test(path)
}

function trackRecordToMusicInfo(track: TrackRecord): MusicInfo {
  return {
    source: track.source,
    songmid: track.songmid,
    name: track.name,
    singer: track.singer,
    albumName: track.albumName,
    albumId: track.albumId,
    interval: track.interval,
    img: track.imageUrl,
    raw: parseTrackRawJson(track.rawJson) ?? track,
  }
}

function parseTrackRawJson(rawJson: string | undefined): unknown {
  if (!rawJson) return undefined
  try {
    return JSON.parse(rawJson) as unknown
  } catch {
    return undefined
  }
}

function handleUserRequest(request: Request, path: string): Response | undefined {
  const requestedUserId = decodeURIComponent(path.split('/')[2] ?? '')
  const account = pathEquals(path, '/Users/Current')
    ? authorizedLocalAccount(request)
    : requestedUserId ? findAccountByLocalOrUpstreamUserId(requestedUserId) : undefined
  if (!account) {
    return Response.json({ error: 'User not found' }, { status: 404 })
  }
  return Response.json(localUser(account))
}

function localUser(account: AccountRecord) {
  return {
    Name: account.embyUsername,
    ServerId: LOCAL_SERVER_ID,
    Id: localUserId(account),
    HasPassword: true,
    HasConfiguredPassword: true,
    HasConfiguredEasyPassword: false,
    EnableAutoLogin: false,
  }
}

function handleUserViewsRequest(path: string): Response {
  const requestedUserId = decodeURIComponent(path.split('/')[2] ?? '')
  const account = findAccountByLocalOrUpstreamUserId(requestedUserId)
  if (!account) {
    return Response.json({ error: 'User not found' }, { status: 404 })
  }

  return Response.json({
    Items: [{
      Name: 'XMusic',
      ServerId: LOCAL_SERVER_ID,
      Id: MUSIC_LIBRARY_ID,
      Type: 'CollectionFolder',
      CollectionType: 'music',
      IsFolder: true,
      UserData: {
        PlaybackPositionTicks: 0,
        PlayCount: 0,
        IsFavorite: false,
      },
    }],
    TotalRecordCount: 1,
  })
}

function findAccountByLocalOrUpstreamUserId(userId: string): AccountRecord | undefined {
  return getAccountByEmbyUserId(userId) ?? listAccounts().find(account => localUserId(account) === userId)
}

function isLocallyHandledFavoriteItemMutation(path: string): boolean {
  const itemId = extractFavoriteItemId(path)
  return Boolean(itemId && (decodeVirtualId(itemId) || getMappedSongmidForEmbyItemId(itemId)))
}

function isLocalEmptyCollectionRequest(path: string): boolean {
  return /^\/Users\/[^/]+\/(?:Albums|Artists|AlbumArtists|Genres|FavoriteItems|Items\/Latest|Items\/Resume)$/i.test(path)
    || /^\/Artists\/AlbumArtists$/i.test(path)
    || /^\/(?:Albums|Artists|AlbumArtists|Genres|MusicGenres|Years|Studios|Persons)$/i.test(path)
}

function emptyItemsResponse(): Response {
  return Response.json({ Items: [], TotalRecordCount: 0 })
}

function emptyImageResponse(): Response {
  return new Response(null, { status: 204, headers: { 'x-x-music-source': 'local' } })
}

async function handleImageRequest(request: Request, embyPath: string): Promise<Response> {
  const itemId = extractImageItemId(embyPath)
  if (!itemId) return emptyImageResponse()
  if (isMusicLibraryId(itemId)) return emptyImageResponse()
  if (/^\/Users\/[^/]+\/Images\//i.test(embyPath) && findAccountByLocalOrUpstreamUserId(itemId)) return emptyImageResponse()

  const decoded = decodeClientVirtualId(itemId)
  if (!decoded) {
    const songmid = localSongmidForExternalItemId(itemId) ?? (looksLikeQQSongMid(itemId) ? itemId : undefined)
    if (!songmid) return proxyToUpstreamEmby(request, embyPath)
    const localCover = await readCachedTrackCover({ source: 'tx', songmid })
    if (localCover) return markRequestSource(localCover, 'local')
    const stored = await loadOrFetchVirtualSong(songmid)
    const imageUrl = stored?.song.img
    return imageUrl ? fetchVirtualImageResponse(imageUrl) : markRequestSource(emptyImageResponse(), 'local')
  }

  if (decoded.kind === 'qq-song') {
    const response = await virtualSongImageResponse(request, decoded)
    if (response) return response
  }

  const imageUrl = virtualImageUrl(decoded)
  if (!imageUrl) return emptyImageResponse()

  return fetchVirtualImageResponse(imageUrl)
}

async function virtualSongImageResponse(
  request: Request,
  decoded: Extract<VirtualId, { kind: 'qq-song' }>,
): Promise<Response | undefined> {
  const localCover = await readCachedTrackCover({ source: 'tx', songmid: decoded.songmid })
  if (localCover) return markRequestSource(localCover, 'local')

  const stored = await loadOrFetchVirtualSong(decoded.songmid, decoded.playlistId)
  if (stored) {
    const mapped = await resolveEmbyTrackMapping(stored.song)
    if (mapped) {
      const proxied = await proxyToUpstreamEmby(request, `/Items/${encodeURIComponent(mapped)}/Images/Primary`).catch(() => undefined)
      if (proxied?.ok || proxied?.status === 304) return proxied
    }
    if (stored.song.img) return fetchVirtualImageResponse(stored.song.img)
  }

  return undefined
}

async function fetchVirtualImageResponse(imageUrl: string): Promise<Response> {
  const cached = await cachedResourceResponse({
    source: 'tx',
    resourceType: 'image',
    url: imageUrl,
    headers: {
      'user-agent': 'Mozilla/5.0',
      referer: 'https://y.qq.com/',
    },
    timeoutMs: 10_000,
  }).catch(() => undefined)
  if (!cached) return emptyImageResponse()

  cached.completion?.catch((error: unknown) => {
    console.warn(`QQ image cache failed for ${imageUrl}: ${error instanceof Error ? error.message : String(error)}`)
  })
  return markRequestSource(cached.response, 'local')
}

async function handleItemsRequest(request: Request, embyPath: string): Promise<Response | undefined> {
  const url = new URL(request.url)
  const searchTerm = url.searchParams.get('SearchTerm') ?? url.searchParams.get('searchTerm') ?? url.searchParams.get('search')
  const includeTypes = url.searchParams.get('IncludeItemTypes') ?? url.searchParams.get('includeItemTypes') ?? ''
  const parentId = url.searchParams.get('ParentId') ?? url.searchParams.get('parentId') ?? ''
  const decodedParentId = decodeVirtualId(parentId)

  if (decodedParentId) {
    return handleVirtualPlaylistItemsRequest(request, decodedParentId, parentId)
  }

  const requestedTypes = parseIncludeTypes(includeTypes)
  if (hasVirtualArtistFilter(url)) {
    return handleVirtualArtistItemsRequest(request, url, requestedTypes)
  }

  const decodedGenreIds = virtualGenreIds(url)
  if (decodedGenreIds.length > 0) {
    return handleVirtualGenreItemsRequest(request, decodedGenreIds, requestedTypes, url)
  }

  const filters = requestFilters(url)
  const page = requestPageParams(url)
  const desiredCount = desiredFetchCount(page)

  if (searchTerm?.trim()) {
    const query = searchTerm.trim()
    const searchPage = cappedPageParams(page, MAX_EMBY_SEARCH_VIRTUAL_ITEMS)
    const virtualSearchCount = Math.min(desiredFetchCount(searchPage), MAX_EMBY_SEARCH_VIRTUAL_ITEMS)
    const upstreamPromise = timedResult(tryReadItemsResponse(request, embyPath, searchPage))
    const songsPromise = shouldIncludeType(requestedTypes, 'audio')
      ? timedResult(searchQQMusicWindow(query, virtualSearchCount))
      : Promise.resolve<TimedResult<WindowResult<MusicInfo>> | undefined>(undefined)
    const playlistsPromise = shouldIncludeType(requestedTypes, 'playlist')
      ? timedResult(searchQQPlaylistsWindow(query, virtualSearchCount))
      : Promise.resolve<TimedResult<WindowResult<QQPlaylistInfo>> | undefined>(undefined)
    const [upstreamSearch, songSearch, playlistSearch] = await Promise.all([upstreamPromise, songsPromise, playlistsPromise])
    const upstream = upstreamSearch.result
    const songs = songSearch?.result
    const playlists = playlistSearch?.result
    const upstreamItems = filterItemsByTypes(upstream?.Items ?? [], requestedTypes)
    const virtualItems: any[] = []

    if (songs) {
      virtualItems.push(...dedupeSongs(songs.items)
        .filter(song => !hasEquivalentEmbySong(upstreamItems, song))
        .map(song => {
          rememberVirtualSong(song)
          return songToEmbyItem(song)
        }))
    }

    if (playlists) {
      virtualItems.push(...playlists.items
        .filter(playlist => !hasEquivalentEmbyPlaylist(upstreamItems, playlist.name))
        .map(playlistToEmbyItem))
    }

    const response = upstreamFirstPagedResponse(upstreamItems, filteredUpstreamTotal(upstream, upstreamItems), virtualItems, virtualItems.length, searchPage)
    response.headers.set('Server-Timing', [
      `emby-upstream;dur=${Math.max(0, upstreamSearch.durationMs)}`,
      songSearch ? `qq-search;dur=${Math.max(0, songSearch.durationMs)}` : undefined,
      playlistSearch ? `qq-playlists;dur=${Math.max(0, playlistSearch.durationMs)}` : undefined,
    ].filter(Boolean).join(', '))
    return response
  }

  if (filters.has('isplayed') && shouldIncludeType(requestedTypes, 'audio')) {
    const upstream = await tryReadItemsResponse(request, embyPath)
    const upstreamItems = filterItemsByTypes(upstream?.Items ?? [], requestedTypes)
    const localItems = localPlayHistoryToEmbyItems(desiredCount)
      .filter(item => !hasEquivalentEmbyItem(upstreamItems, item))
    const merged = sortPlayedItems([...upstreamItems, ...localItems], url.searchParams.get('SortBy') ?? url.searchParams.get('sortBy') ?? '')
    return pagedItemsResponse(merged, page)
  }

  if (filters.has('isfavorite') && shouldIncludeType(requestedTypes, 'audio')) {
    const [upstream, favorites] = await Promise.all([
      tryReadItemsResponse(request, embyPath, { startIndex: 0, limit: MAX_EMBY_LIST_LIMIT }),
      listQQFavoriteSongs(request, desiredCount),
    ])
    const upstreamItems = filterItemsByTypes(upstream?.Items ?? [], requestedTypes)
    const localFavoriteState = localFavoriteStateForRequest(request)
    const virtualFavoriteSongs = applyLocalFavoriteState(favorites.items, localFavoriteState)
    const virtualItems = virtualFavoriteSongs
      .filter(song => !hasEquivalentEmbySong(upstreamItems, song))
      .map((song, index) => {
        rememberVirtualSong(song)
        return favoriteSongToEmbyItem(song, index)
    })
    const merged = sortFavoriteItems([...upstreamItems, ...virtualItems])
    const total = calibrateFavoriteTotal(request, page, merged.length, filteredUpstreamTotal(upstream, upstreamItems), favorites.rawCount, favorites.complete === true)
    return pagedItemsResponse(merged, page, total)
  }

  if (isMusicLibraryId(parentId) && requestedTypes.has('musicalbum')) {
    const upstream = await tryReadItemsResponse(request, embyPath)
    return upstream ? Response.json(upstream) : emptyItemsResponse()
  }

  if (requestedTypes.has('playlist')) {
    const upstream = await tryReadItemsResponse(request, embyPath)
    const playlists = await listVirtualPlaylists(request, desiredCount)
    const upstreamItems = upstream?.Items ?? []
    const virtualItems = playlists
      .filter(playlist => !hasEquivalentEmbyPlaylist(upstreamItems, playlist.name))
      .map(playlistToEmbyItem)
    const pinnedVirtualItems = virtualItems.filter(isPinnedRecommendationPlaylistItem)
    const otherVirtualItems = virtualItems.filter(item => !isPinnedRecommendationPlaylistItem(item))
    const merged = [...pinnedVirtualItems, ...upstreamItems, ...otherVirtualItems]
    return pagedItemsResponse(merged, page)
  }

  if (isMusicLibraryId(parentId)) {
    const upstream = await tryReadItemsResponse(request, embyPath)
    return upstream ? Response.json(upstream) : emptyItemsResponse()
  }

  return undefined
}

async function handleVirtualGenreItemsRequest(
  request: Request,
  genreIds: string[],
  requestedTypes: Set<string>,
  url: URL,
): Promise<Response> {
  if (!shouldIncludeType(requestedTypes, 'audio') && !shouldIncludeType(requestedTypes, 'musicalbum')) {
    return emptyItemsResponse()
  }

  const page = requestPageParams(url)
  const songs = await listQQFavoriteSongs(request, Number.POSITIVE_INFINITY)
  const favoriteSongs = applyLocalFavoriteState(songs.items, localFavoriteStateForRequest(request))
  const filtered = favoriteSongs.filter(song => {
    const genres = songGenres(song)
    const normalized = genres.length > 0 ? genres : ['QQ Music']
    return normalized.some(genre => genreIds.includes(genre))
  })

  const items = shouldIncludeType(requestedTypes, 'musicalbum') && !shouldIncludeType(requestedTypes, 'audio')
    ? favoriteSongsToAlbumItems(filtered)
    : filtered.map(song => {
      rememberVirtualSong(song)
      return songToEmbyItem(song, undefined, true)
    })

  return pagedItemsResponse(items, page)
}

async function handleVirtualArtistItemsRequest(
  request: Request,
  url: URL,
  requestedTypes: Set<string>,
): Promise<Response> {
  if (!shouldIncludeType(requestedTypes, 'audio')) return emptyItemsResponse()

  const page = requestPageParams(url)
  const desiredCount = desiredFetchCount(page)
  const artistNames = virtualArtistNames(url)
  if (!artistNames.length) return emptyItemsResponse()

  const normalizedArtists = new Set(artistNames.map(normalizeText).filter(Boolean))
  const cached = listVirtualSongs()
    .map(entry => entry.song)
    .filter(song => {
      const songArtists = splitArtists(song.singer).map(normalizeText)
      return songArtists.some(artist => normalizedArtists.has(artist))
    })
  if (cached.length > 0) {
    const items = dedupeSongs(cached).slice(0, finiteFetchCount(desiredCount))
      .map(song => songToEmbyItem(song))
    return pagedItemsResponse(items, page, cached.length)
  }

  const favorites = await listQQFavoriteSongs(request, Number.POSITIVE_INFINITY)
  const favoriteSongs = applyLocalFavoriteState(favorites.items, localFavoriteStateForRequest(request))
  const filtered = favoriteSongs.filter(song => {
    const songArtists = splitArtists(song.singer).map(normalizeText)
    return songArtists.some(artist => normalizedArtists.has(artist))
  })
  const items = filtered.slice(0, finiteFetchCount(desiredCount))
    .map(song => {
      rememberVirtualSong(song)
      return songToEmbyItem(song, undefined, true)
    })
  return pagedItemsResponse(items, page, filtered.length)
}

async function handleCollectionRequest(request: Request, embyPath: string): Promise<Response> {
  const upstream = await tryReadItemsResponse(request, embyPath)
  if (!isGenresCollectionPath(embyPath)) {
    return upstream ? Response.json(upstream) : emptyItemsResponse()
  }

  const url = new URL(request.url)
  const includeTypes = parseIncludeTypes(url.searchParams.get('IncludeItemTypes') ?? url.searchParams.get('includeItemTypes') ?? '')
  if (!shouldIncludeType(includeTypes, 'musicalbum')) {
    return upstream ? Response.json(upstream) : emptyItemsResponse()
  }

  const page = requestPageParams(url)
  const favorites = await listQQFavoriteSongs(request, Number.POSITIVE_INFINITY)
  const favoriteSongs = applyLocalFavoriteState(favorites.items, localFavoriteStateForRequest(request))
  const qqGenres = favoriteSongsToGenreItems(favoriteSongs)
  const upstreamItems = upstream?.Items ?? []
  const merged = [
    ...upstreamItems,
    ...qqGenres.filter(genre => !upstreamItems.some(item => normalizeText(String(item?.Name ?? '')) === normalizeText(genre.Name))),
  ]
  return pagedItemsResponse(merged, page)
}

async function handlePlaybackReportRequest(request: Request, embyPath: string): Promise<Response | undefined> {
  const body = await request.clone().json().catch(() => undefined) as { ItemId?: unknown } | undefined
  const itemId = typeof body?.ItemId === 'string' ? body.ItemId : ''
  const decoded = await resolveSongVirtualId(itemId)
  if (!decoded || decoded.kind !== 'qq-song') return undefined

  const stored = loadVirtualSong(decoded.songmid)
  if (stored && /\/Stopped$/i.test(embyPath)) {
    const playableQuality = playableQualityForSong(stored.song)
    const quality = playableQuality ?? '320k'
    const track = ensureTrack(stored.song)
    insertPlayEvent(track.id, quality, authorizedLocalAccount(request)?.qqUin)
    if (hasSyncableEmbyMedia(stored.song)) {
      enqueueEmbyTrackSync({
        source: stored.song.source,
        songmid: stored.song.songmid,
        playlistId: decoded.playlistId ?? stored.playlistId,
        musicInfo: stored.song,
      })
    }
  }

  return new Response(null, { status: 204 })
}

async function handleItemRequest(request: Request, embyPath: string): Promise<Response | undefined> {
  const itemId = extractItemId(embyPath)
  if (!itemId) return undefined

  const mapped = mappingForExternalTrackItemId(itemId)
  if (mapped) {
    const upstream = await proxyToUpstreamEmby(request, embyPath).catch(() => undefined)
    if (isUsableUpstreamResponse(upstream)) return upstream
    deleteStaleTrackMapping(mapped)
    const songmid = songmidFromTrackMapping(mapped)
    if (songmid) {
      const stored = await loadOrFetchVirtualSong(songmid)
      if (!stored) return Response.json({ error: 'Virtual QQ song metadata is not cached. Search or open the virtual playlist again.' }, { status: 404 })
      return Response.json(songToEmbyItem(stored.song))
    }
  }

  const decoded = await resolveSongVirtualId(itemId)
  if (!decoded) return undefined

  if (decoded.kind !== 'qq-song') {
    const item = virtualContainerToEmbyItem(decoded)
    return item ? Response.json(item) : undefined
  }

  const stored = await loadOrFetchVirtualSong(decoded.songmid, decoded.playlistId)
  if (!stored) {
    return Response.json({ error: 'Virtual QQ song metadata is not cached. Search or open the virtual playlist again.' }, { status: 404 })
  }

  return Response.json(songToEmbyItem(stored.song, decoded.playlistId ?? stored.playlistId))
}

async function handlePlaybackInfoRequest(embyPath: string): Promise<Response | undefined> {
  const itemId = extractNestedItemId(embyPath, 'PlaybackInfo')
  const decoded = itemId ? decodeVirtualId(itemId) : undefined
  if (!decoded || decoded.kind !== 'qq-song') return undefined

  const stored = await loadOrFetchVirtualSong(decoded.songmid, decoded.playlistId)
  if (!stored) {
    return Response.json({ error: 'Virtual QQ song metadata is not cached. Search or open the virtual playlist again.' }, { status: 404 })
  }

  const mediaSource = songMediaSource(stored.song, intervalToTicks(stored.song.interval))
  return Response.json({
    MediaSources: [mediaSource],
    PlaySessionId: crypto.randomUUID(),
    ErrorCode: 'NoError',
  })
}

async function handleSimilarItemsRequest(request: Request, embyPath: string): Promise<Response | undefined> {
  const itemId = extractNestedItemId(embyPath, 'Similar')
  const decoded = itemId ? decodeVirtualId(itemId) : undefined
  if (!decoded || decoded.kind !== 'qq-song') return undefined

  const stored = await loadOrFetchVirtualSong(decoded.songmid, decoded.playlistId)
  const seed = stored?.song
  if (!seed) return emptyItemsResponse()

  const url = new URL(request.url)
  const page = requestPageParams(url)
  const limit = finiteFetchCount(desiredFetchCount(page), 20)
  const related = await searchQQMusicWindow([seed.singer, seed.albumName].filter(Boolean).join(' ') || seed.name, limit)
  const items = related.items
    .filter(song => song.songmid !== seed.songmid)
    .map(song => {
      rememberVirtualSong(song)
      return songToEmbyItem(song)
    })
  return pagedItemsResponse(items, page, items.length)
}

async function handleLyricsRequest(request: Request, embyPath: string): Promise<Response | undefined> {
  if (!isAuthorizedLocalRequest(request) && !subsonicAccountForRequest(request)) return unauthorizedResponse()
  const itemId = extractNestedItemId(embyPath, 'Lyrics')
  const mapped = itemId ? mappingForExternalTrackItemId(itemId) : undefined
  if (mapped) {
    const upstream = await proxyToUpstreamEmby(request, embyPath).catch(() => undefined)
    if (isUsableUpstreamResponse(upstream)) return upstream
    deleteStaleTrackMapping(mapped)
  }

  const decoded = itemId ? await resolveSongVirtualId(itemId) : undefined
  if (!decoded) return undefined

  const lyrics = await fetchLyrics(decoded.songmid, decoded.playlistId)
  if (wantsRawLyrics(request)) {
    return markRequestSource(new Response(lyrics ?? '', {
      status: lyrics ? 200 : 404,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=86400',
      },
    }), 'local')
  }

  if (!lyrics) {
    return markRequestSource(Response.json({
      Lyrics: [],
      Lines: [],
      Metadata: {
        Provider: 'XMusic',
      },
    }), 'local')
  }

  const lines = parseLrcLyrics(lyrics)
  return markRequestSource(Response.json({
    Lyrics: lines,
    Lines: lines,
    Text: lyrics,
    Metadata: {
      Provider: 'QQ Music',
      IsSynced: true,
    },
  }), 'local')
}

async function handleSubsonicGetSongRequest(request: Request): Promise<Response> {
  if (!isAuthorizedLocalRequest(request) && !subsonicAccountForRequest(request)) return subsonicResponse(request, { error: { code: 40, message: 'Unauthorized' } }, 401)
  const url = new URL(request.url)
  const rawId = url.searchParams.get('id') ?? ''
  const decoded = await resolveSongVirtualId(rawId)
  if (!decoded) return subsonicResponse(request, { error: { code: 70, message: 'Song not found' } }, 404)

  const stored = await loadOrFetchVirtualSong(decoded.songmid, decoded.playlistId)
  if (!stored) return subsonicResponse(request, { error: { code: 70, message: 'Song not found' } }, 404)

  return subsonicResponse(request, { song: songToSubsonicChild(stored.song) })
}

async function handleSubsonicLyricsRequest(request: Request): Promise<Response> {
  if (!isAuthorizedLocalRequest(request) && !subsonicAccountForRequest(request)) return subsonicResponse(request, { error: { code: 40, message: 'Unauthorized' } }, 401)
  const url = new URL(request.url)
  const rawId = url.searchParams.get('id') ?? ''
  const decoded = await resolveSongVirtualId(rawId)
  if (!decoded) return subsonicResponse(request, { lyricsList: { structuredLyrics: [] } })

  const lyrics = await fetchLyrics(decoded.songmid, decoded.playlistId)
  return subsonicResponse(request, {
    lyricsList: {
      structuredLyrics: lyrics ? [subsonicStructuredLyrics(lyrics)] : [],
    },
  })
}

async function handleSubtitleStreamRequest(request: Request, embyPath: string): Promise<Response | undefined> {
  const itemId = extractSubtitleItemId(embyPath)
  const mapped = itemId ? mappingForExternalTrackItemId(itemId) : undefined
  if (mapped) {
    const upstream = await proxyToUpstreamEmby(request, embyPath).catch(() => undefined)
    if (isUsableUpstreamResponse(upstream)) return upstream
    deleteStaleTrackMapping(mapped)
  }

  const decoded = itemId ? await resolveSongVirtualId(itemId) : undefined
  if (!decoded) return undefined

  const lyrics = await fetchLyrics(decoded.songmid, decoded.playlistId)
  const format = subtitleStreamFormat(embyPath)
  const headers = {
    'content-type': subtitleContentType(format),
    'cache-control': 'public, max-age=86400',
  }
  const isJsonSubtitle = format === 'js' || format === 'json'
  if (request.method === 'HEAD') return new Response(null, { status: lyrics || isJsonSubtitle ? 200 : 404, headers })
  if (!lyrics && isJsonSubtitle) return new Response(formatSubtitleStream('', format), { status: 200, headers })
  return new Response(lyrics ? formatSubtitleStream(lyrics, format) : '', { status: lyrics ? 200 : 404, headers })
}

function virtualContainerToEmbyItem(decoded: VirtualId): any | undefined {
  if (decoded.kind === 'qq-playlist') {
    const playlist = loadVirtualPlaylist(decoded.id)
    return playlist ? playlistToEmbyItem(playlist) : undefined
  }

  if (decoded.kind === 'qq-daily') {
    return playlistToEmbyItem(loadVirtualPlaylist('__daily__') ?? defaultVirtualPlaylist('__daily__'))
  }

  if (decoded.kind === 'qq-guess') {
    return playlistToEmbyItem(loadVirtualPlaylist('__guess__') ?? defaultVirtualPlaylist('__guess__'))
  }

  if (decoded.kind === 'qq-album') {
    const songs = loadVirtualAlbumSongs(decoded.id)
    const first = songs[0]
    if (!first) return undefined
    const artists = dedupeStrings(songs.flatMap(song => splitArtists(song.singer)))
    return {
      Name: first.albumName || 'Unknown Album',
      ServerId: LOCAL_SERVER_ID,
      Id: albumVirtualId(decoded.id),
      Type: 'MusicAlbum',
      MediaType: 'Audio',
      IsFolder: true,
      AlbumArtist: artists[0] ?? '',
      AlbumArtists: artists,
      ArtistItems: artists.map((name, index) => ({ Name: name, Id: `${decoded.id}-album-artist-${index}` })),
      ChildCount: songs.length,
      RecursiveItemCount: songs.length,
      ImageTags: first.img ? { Primary: first.albumId || first.songmid } : {},
      UserData: {
        PlaybackPositionTicks: 0,
        PlayCount: 0,
        IsFavorite: true,
      },
    }
  }

  if (decoded.kind === 'qq-genre') {
    return {
      Name: decoded.id,
      ServerId: LOCAL_SERVER_ID,
      Id: genreVirtualId(decoded.id),
      Type: 'Genre',
      IsFolder: true,
      UserData: {
        PlaybackPositionTicks: 0,
        PlayCount: 0,
        IsFavorite: false,
      },
    }
  }

  return undefined
}

async function handlePlaylistItemsRequest(request: Request, embyPath: string): Promise<Response | undefined> {
  const playlistId = extractPlaylistId(embyPath)
  if (!playlistId) return undefined

  const decoded = decodeVirtualId(playlistId)
  if (!decoded) return undefined

  if (decoded.kind === 'qq-playlist') {
    const playlist = loadVirtualPlaylist(decoded.id)
    const mapped = getRemoteMapping({ localType: 'playlist', localKey: `qq:${decoded.id}`, remote: 'emby' })?.remoteId
      ?? (playlist ? await searchEmbyPlaylistByName(playlist.name).catch(() => undefined) : undefined)
    if (mapped) {
      upsertRemoteMapping({ localType: 'playlist', localKey: `qq:${decoded.id}`, remote: 'emby', remoteId: mapped, raw: playlist })
      return proxyToUpstreamEmby(request, `/Playlists/${encodeURIComponent(mapped)}/Items`)
    }
  }

  return handleVirtualPlaylistItemsRequest(request, decoded, playlistId)
}

async function handleVirtualPlaylistItemsRequest(request: Request, decoded: VirtualId, playlistId: string): Promise<Response | undefined> {
  const url = new URL(request.url)
  const includeTypes = parseIncludeTypes(url.searchParams.get('IncludeItemTypes') ?? url.searchParams.get('includeItemTypes') ?? '')
  if (!shouldIncludePlaylistTracks(includeTypes)) {
    return emptyItemsResponse()
  }
  const page = requestPageParams(url)
  const desiredCount = desiredFetchCount(page)

  let songs: MusicInfo[] = []
  let total: number | undefined
  if (decoded.kind === 'qq-playlist') {
    const result = await getQQPlaylistSongsWindow(decoded.id, desiredCount)
    songs = result.items
    total = result.total
  } else if (decoded.kind === 'qq-album') {
    songs = loadVirtualAlbumSongs(decoded.id)
    total = songs.length
  } else if (decoded.kind === 'qq-guess') {
    const result = await getQQRecommendationsWindow(request, desiredCount)
    songs = result.items
    total = result.total
  } else if (decoded.kind === 'qq-daily') {
    const result = await getQQDailyRecommendationsWindow(desiredCount)
    songs = result.items
    total = result.total
  } else {
    return undefined
  }

  const searchTerm = url.searchParams.get('SearchTerm') ?? url.searchParams.get('searchTerm') ?? url.searchParams.get('search')
  const items = dedupeSongs(songs)
    .filter(song => matchesSongSearch(song, searchTerm))
    .map(song => {
    rememberVirtualSong(song, playlistId)
    return songToEmbyItem(song, playlistId)
  })
  return pagedItemsResponse(items, page, total ?? items.length)
}

async function handleAudioRequest(request: Request, embyPath: string): Promise<Response | undefined> {
  const itemId = decodeURIComponent(embyPath.split('/')[2] ?? '')
  const staleCandidate = mappingForExternalTrackItemId(itemId)
  if (staleCandidate) {
    const proxied: Response | undefined = await proxyToUpstreamEmby(request, embyPath).catch((error: unknown) => {
      logVirtualAudioEvent('virtual_audio_stale_mapping_proxy_failed', request, {
        itemId,
        mappedItemId: staleCandidate.remoteId,
        localKey: staleCandidate.localKey,
        error: errorMessage(error),
      }, 'error')
      return undefined
    })
    const upstreamStatus = proxied?.status
    if (isUsableUpstreamResponse(proxied)) return proxied
    logVirtualAudioEvent('virtual_audio_stale_mapping_removed', request, {
      itemId,
      mappedItemId: staleCandidate.remoteId,
      localKey: staleCandidate.localKey,
      upstreamStatus,
    })
    deleteStaleTrackMapping(staleCandidate)
  }

  const decoded = await resolveSongVirtualId(itemId)
  if (!decoded || decoded.kind !== 'qq-song') return undefined

  const stored = await loadOrFetchVirtualSong(decoded.songmid, decoded.playlistId)
  if (!stored) {
    logVirtualAudioEvent('virtual_audio_metadata_missing', request, {
      itemId,
      songmid: decoded.songmid,
      playlistId: decoded.playlistId,
    }, 'error')
    return Response.json({ error: 'Virtual QQ song metadata is not cached. Search or open the virtual playlist again.' }, { status: 404 })
  }

  const musicInfo = stored.song
  if (request.method === 'HEAD') {
    const playableHeaders = await virtualAudioHeadHeaders(musicInfo, preferredAudioQualityForRequest(request, musicInfo))
    return markRequestSource(new Response(null, { status: 200, headers: playableHeaders }), playableHeaders.get('content-length') ? 'local' : 'upstream')
  }

  const preferredQuality = preferredAudioQualityForRequest(request, musicInfo)
  const mappedItemId = await resolveEmbyTrackMapping(musicInfo)
  if (mappedItemId) {
    const action = embyPath.split('/')[3] ?? 'universal'
    const proxied: Response | undefined = await proxyToUpstreamEmby(request, `/Audio/${encodeURIComponent(mappedItemId)}/${action}`).catch((error: unknown) => {
      logVirtualAudioEvent('virtual_audio_mapped_proxy_failed', request, {
        itemId,
        songmid: decoded.songmid,
        mappedItemId,
        action,
        preferredQuality,
        error: errorMessage(error),
      }, 'error')
      return undefined
    })
    const upstreamStatus = proxied?.status
    if (proxied?.ok || proxied?.status === 206) return proxied
    logVirtualAudioEvent('virtual_audio_mapped_proxy_unusable', request, {
      itemId,
      songmid: decoded.songmid,
      mappedItemId,
      action,
      preferredQuality,
      upstreamStatus,
    }, 'error')
  }

  const playableFile = getPreferredPlayableFile(musicInfo, preferredQuality)
  const localPath = playableFile?.finalPath ?? playableFile?.rawPath

  if (playableFile && localPath) {
    const track = ensureTrack(musicInfo)
    insertPlayEvent(track.id, playableFile.quality, authorizedLocalAccount(request)?.qqUin)
    syncQQPlayHistoryFromStoredUrlBestEffort(request, musicInfo, playableFile.quality)
    if (hasSyncableEmbyMedia(musicInfo)) {
      enqueueEmbyTrackSync({
        source: musicInfo.source,
        songmid: musicInfo.songmid,
        playlistId: decoded.playlistId ?? stored.playlistId,
        musicInfo,
      })
    } else {
      ensureEmbyMasterCachedBestEffort({ musicInfo, track })
    }
    return markRequestSource(await streamLocalFile(localPath, request), 'local')
  }

  const waitedFile = await waitForActivePlayableFile(musicInfo, preferredQuality)
  const waitedPath = waitedFile?.finalPath ?? waitedFile?.rawPath
  if (waitedFile && waitedPath) {
    const track = ensureTrack(musicInfo)
    insertPlayEvent(track.id, waitedFile.quality, authorizedLocalAccount(request)?.qqUin)
    if (hasSyncableEmbyMedia(musicInfo)) {
      enqueueEmbyTrackSync({
        source: musicInfo.source,
        songmid: musicInfo.songmid,
        playlistId: decoded.playlistId ?? stored.playlistId,
        musicInfo,
      })
    } else {
      ensureEmbyMasterCachedBestEffort({ musicInfo, track })
    }
    return markRequestSource(await streamLocalFile(waitedPath, request), 'local')
  }

  const track = ensureTrack(musicInfo)
  try {
    const resolved = await resolvePlayableUpstreamResponse(musicInfo, preferredQuality, track, request, {
      allowFullFallback: shouldAllowFullAudioFallback(request),
    })
    insertPlayEvent(track.id, resolved.quality, authorizedLocalAccount(request)?.qqUin)
    syncQQPlayHistoryBestEffort({
      cookie: qqCookieForRequest(request),
      musicInfo,
      quality: resolved.quality,
      playUrl: resolved.url,
    })
    if (hasSyncableEmbyMedia(musicInfo)) {
      enqueueEmbyTrackSync({
        source: musicInfo.source,
        songmid: musicInfo.songmid,
        playlistId: decoded.playlistId ?? stored.playlistId,
        musicInfo,
      })
    } else if (!isHighestAvailableQuality(musicInfo, resolved.quality)) {
      ensureEmbyMasterCachedBestEffort({ musicInfo, track })
    }
    resolved.completion.catch((error: unknown) => {
      upsertTrackFileStatus(track.id, resolved.quality, 'failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
    return markRequestSource(resolved.response, 'upstream')
  } catch (error) {
    const message = playbackErrorMessage(error)
    upsertTrackFileStatus(track.id, preferredQuality, 'failed', { error: message })
    logVirtualAudioEvent('virtual_audio_playback_failed', request, {
      itemId,
      songmid: decoded.songmid,
      playlistId: decoded.playlistId ?? stored.playlistId,
      preferredQuality,
      availableQualities: availableSongQualities(musicInfo),
      allowFullFallback: shouldAllowFullAudioFallback(request),
      error: message,
      attempts: error instanceof MusicUrlResolveError ? error.attempts : undefined,
    }, 'error')
    return Response.json({ error: message }, { status: 502 })
  }
}

async function resolvePlayableUpstreamResponse(
  musicInfo: MusicInfo,
  preferredQuality: MusicQuality,
  track: TrackRecord,
  request: Request,
  options: { allowFullFallback?: boolean } = {},
): Promise<{
  url: string
  quality: MusicQuality
  response: Response
  completion: Promise<void>
}> {
  const attempts: Array<{ quality: MusicQuality; error: string }> = []
  let encryptedQQRequiresKey = false

  for (const quality of audioQualityFallbacks(preferredQuality, musicInfo, options)) {
    upsertTrackFileStatus(track.id, quality, 'resolving_url')
    try {
      const resolved = await resolveMusicUrl(musicInfo, quality)
      logVirtualAudioEvent('virtual_audio_url_resolved', request, {
        songmid: musicInfo.songmid,
        preferredQuality,
        quality,
        resolvedQuality: resolved.quality,
        upstream: summarizeAudioUrl(resolved.url),
        hasEkey: Boolean(resolved.ekey),
      })
      if (encryptedQQRequiresKey && isEncryptedQQAudioFileName(resolved.url)) {
        const message = 'Skipped encrypted QQ audio because a previous encrypted quality already required a local QQ Music key'
        attempts.push({ quality, error: message })
        upsertTrackFileStatus(track.id, quality, 'failed', { error: message })
        logVirtualAudioEvent('virtual_audio_quality_failed', request, {
          songmid: musicInfo.songmid,
          preferredQuality,
          quality,
          upstream: summarizeAudioUrl(resolved.url),
          error: message,
        }, 'error')
        continue
      }
      const { response, completion } = await createUpstreamTeeResponse(
        resolved.url,
        track,
        resolved.quality,
        request,
        resolved.ekey,
        { librarySync: shouldSyncResolvedQualityToEmby(musicInfo, preferredQuality, resolved.quality, attempts) },
      )
      return {
        url: resolved.url,
        quality: resolved.quality,
        response,
        completion,
      }
    } catch (error) {
      if (error instanceof MusicUrlConfigError) throw error
      const message = error instanceof Error ? error.message : String(error)
      attempts.push({ quality, error: message })
      upsertTrackFileStatus(track.id, quality, 'failed', { error: message })
      logVirtualAudioEvent('virtual_audio_quality_failed', request, {
        songmid: musicInfo.songmid,
        preferredQuality,
        quality,
        error: message,
        encryptedQQRequiresKey: isEncryptedQQAudioRequiresKeyError(error) || undefined,
      }, 'error')
      if (isEncryptedQQAudioRequiresKeyError(error)) encryptedQQRequiresKey = true
    }
  }

  throw new MusicUrlResolveError('Unable to resolve a playable music URL', attempts)
}

function shouldSyncResolvedQualityToEmby(
  musicInfo: MusicInfo,
  preferredQuality: MusicQuality,
  resolvedQuality: MusicQuality,
  attempts: Array<{ quality: MusicQuality; error: string }>,
): boolean {
  if (isHighestAvailableQuality(musicInfo, resolvedQuality)) return true
  return preferredQuality === highestAvailableSongQuality(musicInfo)
    && attempts.some(attempt => attempt.quality === preferredQuality)
}

async function loadOrFetchVirtualSong(songmid: string, playlistId?: string): Promise<{ song: MusicInfo; playlistId?: string } | undefined> {
  const stored = loadVirtualSong(songmid)
  if (stored) return stored

  const tracked = getTrack('tx', songmid)
  if (tracked) {
    const song = trackRecordToMusicInfo(tracked)
    rememberVirtualSong(song, playlistId)
    return { song, playlistId }
  }

  const song = await getQQSongDetail(songmid).catch(() => undefined)
  if (!song) return undefined
  rememberVirtualSong(song, playlistId)
  return { song, playlistId }
}

async function resolveSongVirtualId(itemId: string): Promise<Extract<VirtualId, { kind: 'qq-song' }> | undefined> {
  const decoded = decodeClientVirtualId(itemId)
  if (decoded?.kind === 'qq-song') return decoded

  const songmid = localSongmidForExternalItemId(itemId)
  if (songmid) return { kind: 'qq-song', songmid }

  const remote = await fetchEmbySongForExternalItemId(itemId)
  if (remote) {
    rememberVirtualSong(remote)
    upsertRemoteMapping({
      localType: 'track',
      localKey: `${remote.source}:${remote.songmid}`,
      remote: 'emby',
      remoteId: itemId,
      raw: remote,
    })
    return { kind: 'qq-song', songmid: remote.songmid }
  }

  return undefined
}

function localSongmidForExternalItemId(itemId: string): string | undefined {
  const mapping = mappingForExternalTrackItemId(itemId)
  const songmid = mapping ? songmidFromTrackMapping(mapping) : undefined
  if (songmid) return songmid

  const staleSongmid = staleEmbyTrackAliasSongmid(itemId)
  if (staleSongmid) return staleSongmid

  const track = db.prepare(`
    SELECT t.songmid
    FROM tracks t
    WHERE t.source = 'tx'
      AND (t.songmid = @itemId OR json_extract(t.raw_json, '$.songId') = @numericItemId)
    LIMIT 1
  `).get({ itemId, numericItemId: Number(itemId) }) as { songmid?: string } | undefined
  return track?.songmid
}

function mappingForExternalTrackItemId(itemId: string): RemoteMappingRecord | undefined {
  const mapping = getRemoteMappingByRemote({ remote: 'emby', remoteId: itemId })
  return mapping?.localType === 'track' ? mapping : undefined
}

function songmidFromTrackMapping(mapping: Pick<RemoteMappingRecord, 'localKey'>): string | undefined {
  return mapping.localKey.match(/^tx:(.+)$/)?.[1]
}

function deleteStaleTrackMapping(mapping: Pick<RemoteMappingRecord, 'localType' | 'localKey' | 'remote' | 'remoteId' | 'rawJson'>): void {
  rememberStaleEmbyTrackAlias(mapping)
  deleteRemoteMapping({ localType: mapping.localType, localKey: mapping.localKey, remote: mapping.remote, remoteId: mapping.remoteId })
}

function isUsableUpstreamResponse(response: Response | undefined): response is Response {
  if (!response) return false
  return response.ok || response.status === 206
}

function staleEmbyTrackAliasSongmid(itemId: string): string | undefined {
  const row = db.prepare('SELECT value_json AS valueJson FROM app_settings WHERE key = ?').get(staleEmbyTrackAliasKey(itemId)) as { valueJson?: string } | undefined
  if (!row?.valueJson) return undefined
  try {
    const alias = JSON.parse(row.valueJson) as { source?: string; songmid?: string }
    return alias.source === 'tx' && alias.songmid ? alias.songmid : undefined
  } catch {
    return undefined
  }
}

function rememberStaleEmbyTrackAlias(mapping: Pick<RemoteMappingRecord, 'localKey' | 'remoteId' | 'rawJson'>): void {
  const songmid = songmidFromTrackMapping(mapping)
  if (!songmid) return
  let raw: unknown
  try {
    raw = mapping.rawJson ? JSON.parse(mapping.rawJson) : undefined
  } catch {
    raw = undefined
  }
  db.prepare(`
    INSERT INTO app_settings (key, value_json, updated_at)
    VALUES (@key, @valueJson, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    key: staleEmbyTrackAliasKey(mapping.remoteId),
    valueJson: JSON.stringify({
      source: 'tx',
      songmid,
      staleRemoteId: mapping.remoteId,
      raw,
    }),
  })
}

function staleEmbyTrackAliasKey(itemId: string): string {
  return `stale-emby-track.${itemId}`
}

async function fetchEmbySongForExternalItemId(itemId: string): Promise<MusicInfo | undefined> {
  const item = await fetchEmbyJson<{
    Id?: string
    Name?: string
    Album?: string
    AlbumId?: string
    Artists?: string[]
    ArtistItems?: Array<{ Name?: string }>
    RunTimeTicks?: number
    ImageTags?: { Primary?: string }
    ProviderIds?: Record<string, unknown>
    ExternalIds?: unknown[]
    Path?: string
  }>(`/Items/${encodeURIComponent(itemId)}?${new URLSearchParams({
    Fields: 'Album,AlbumId,Artists,ArtistItems,RunTimeTicks,ImageTags,ProviderIds,ExternalIds,Path',
  })}`).catch(() => undefined)
  if (!item?.Id || !item.Name) return undefined
  const songmid = embyItemSongmid(item)
  if (!songmid) return undefined
  return {
    source: 'tx',
    songmid,
    name: item.Name,
    singer: embyItemArtists(item).join(','),
    albumName: item.Album,
    albumId: item.AlbumId,
    interval: ticksToInterval(item.RunTimeTicks),
    img: item.ImageTags?.Primary ? `/Items/${encodeURIComponent(item.Id)}/Images/Primary` : undefined,
    raw: { embyId: item.Id },
  }
}

function embyItemSongmid(item: { ProviderIds?: Record<string, unknown>; ExternalIds?: unknown[]; Path?: string; Id?: string }): string | undefined {
  const providerIds = item.ProviderIds ?? {}
  for (const key of ['QQMusic', 'QQ', 'TxMusic', 'SongMid', 'songmid']) {
    const value = providerIds[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }

  for (const external of Array.isArray(item.ExternalIds) ? item.ExternalIds : []) {
    if (!external || typeof external !== 'object') continue
    const record = external as Record<string, unknown>
    const name = String(record.Name ?? record.Site ?? record.ProviderName ?? '').toLowerCase()
    const value = typeof record.Value === 'string' ? record.Value.trim() : ''
    if (value && (name.includes('qq') || name.includes('songmid'))) return value
  }

  const pathMatch = item.Path?.match(/(?:^|[?&/_-])(?:songmid|mid)[=_-]([A-Za-z0-9]+)/i)
  return pathMatch?.[1]
}

function embyItemArtists(item: { Artists?: string[]; ArtistItems?: Array<{ Name?: string }> }): string[] {
  const artists = item.Artists?.filter(Boolean) ?? []
  if (artists.length) return artists
  return item.ArtistItems?.map(artist => artist.Name).filter((name): name is string => Boolean(name)) ?? []
}

function ticksToInterval(ticks?: number): string | undefined {
  if (!Number.isFinite(ticks) || !ticks) return undefined
  const totalSeconds = Math.max(0, Math.round(ticks / 10_000_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

async function waitForActivePlayableFile(musicInfo: MusicInfo, preferredQuality: MusicQuality): Promise<ReturnType<typeof getPlayableTrackFile> | undefined> {
  const qualities = qualityFallbacks(preferredQuality)
  if (!hasActiveTrackFile(musicInfo.source, musicInfo.songmid, qualities)) return undefined

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 250))
    const file = getPreferredPlayableFile(musicInfo, preferredQuality)
    if (file) return file
  }
  return undefined
}

function getPreferredPlayableFile(musicInfo: MusicInfo, preferredQuality: MusicQuality): ReturnType<typeof getPlayableTrackFile> | undefined {
  const preferredFile = getPlayableTrackFile(musicInfo.source, musicInfo.songmid, preferredQuality)
  if (preferredFile) return preferredFile
  if (shouldRefreshPreferredQualityBeforeLocalFallback(musicInfo, preferredQuality)) return undefined
  return qualityFallbacks(preferredQuality)
    .slice(1)
    .map((quality) => getPlayableTrackFile(musicInfo.source, musicInfo.songmid, quality))
    .find((candidate) => candidate !== undefined)
}

function shouldRefreshPreferredQualityBeforeLocalFallback(musicInfo: MusicInfo, preferredQuality: MusicQuality): boolean {
  return preferredQuality === 'flac' && availableSongQualities(musicInfo).includes('flac')
}

function syncQQPlayHistoryFromStoredUrlBestEffort(request: Request, musicInfo: MusicInfo, quality: MusicQuality): void {
  const cookie = qqCookieForRequest(request)
  try {
    if (!getQQLoginState({ cookie })) return
  } catch (error) {
    debugBackgroundSync(`QQ play history sync skipped for ${musicInfo.songmid}: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  void resolveMusicUrlWithFallback(musicInfo, quality).then((resolved) => {
    syncQQPlayHistoryBestEffort({
      cookie,
      musicInfo,
      quality: resolved.quality,
      playUrl: resolved.url,
    })
  }).catch((error: unknown) => {
    debugBackgroundSync(`QQ play history URL resolve failed for ${musicInfo.songmid}: ${error instanceof Error ? error.message : String(error)}`)
  })
}

function debugBackgroundSync(message: string, error?: unknown): void {
  if (process.env.X_MUSIC_DEBUG_BACKGROUND_SYNC === '1') console.debug(message, error ?? '')
}

function qqCookieForRequest(request: Request): string | undefined {
  return authorizedLocalAccount(request)?.qqCookie
    ?? request.headers.get('x-qq-music-cookie')
    ?? undefined
}

function validEmbyTrackMapping(musicInfo: MusicInfo): string | undefined {
  const mapping = getRemoteMapping({ localType: 'track', localKey: `${musicInfo.source}:${musicInfo.songmid}`, remote: 'emby' })
  if (!mapping?.remoteId) return undefined
  if (!mapping.rawJson) return undefined
  try {
    const raw = JSON.parse(mapping.rawJson) as Partial<MusicInfo>
    if (
      raw.source === musicInfo.source
      && raw.songmid === musicInfo.songmid
      && normalizeText(raw.name ?? '') === normalizeText(musicInfo.name)
    ) {
      return mapping.remoteId
    }
  } catch {
    return undefined
  }
  return undefined
}

async function resolveEmbyTrackMapping(musicInfo: MusicInfo): Promise<string | undefined> {
  const mapped = validEmbyTrackMapping(musicInfo)
    ?? await searchEmbyAudioByName(musicInfo).catch(() => undefined)
  if (!mapped) return undefined
  upsertRemoteMapping({
    localType: 'track',
    localKey: `${musicInfo.source}:${musicInfo.songmid}`,
    remote: 'emby',
    remoteId: mapped,
    raw: musicInfo,
  })
  return mapped
}

async function virtualAudioHeadHeaders(musicInfo: MusicInfo, preferredQuality: MusicQuality = 'flac'): Promise<Headers> {
  const playableFile = getPreferredPlayableFile(musicInfo, preferredQuality)
  const localPath = playableFile?.finalPath ?? playableFile?.rawPath

  if (localPath) {
    const fileStat = await stat(localPath).catch(() => undefined)
    if (fileStat) {
      return new Headers({
        'content-type': audioContentTypeFromPath(localPath),
        'content-length': String(fileStat.size),
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      })
    }
  }

  return new Headers({
    'content-type': 'audio/mpeg',
    'accept-ranges': 'none',
    'cache-control': 'max-age=30',
  })
}

function hasSyncableEmbyMedia(musicInfo: MusicInfo): boolean {
  return hasEmbySyncableCachedMedia({
    source: musicInfo.source,
    songmid: musicInfo.songmid,
    musicInfo,
  })
}

function playableQualityForSong(musicInfo: MusicInfo): MusicQuality | undefined {
  return qualityFallbacks('flac')
    .find((quality) => getPlayableTrackFile(musicInfo.source, musicInfo.songmid, quality) !== undefined)
}

function preferredAudioQualityForRequest(request: Request, musicInfo: MusicInfo): MusicQuality {
  const url = new URL(request.url)
  const pathQuality = preferredAudioQualityForPath(url.pathname)
  if (pathQuality && availableSongQualities(musicInfo).includes(pathQuality)) return pathQuality
  const container = (url.searchParams.get('Container') ?? url.searchParams.get('container') ?? '').toLowerCase()
  const audioCodec = (url.searchParams.get('AudioCodec') ?? url.searchParams.get('audioCodec') ?? '').toLowerCase()
  const available = availableSongQualities(musicInfo)
  if (containerSupportsFlac(container) && available.includes('flac')) return 'flac'
  if ((container.includes('mp3') || audioCodec.includes('mp3')) && available.includes('320k')) return '320k'
  if ((container.includes('mp3') || audioCodec.includes('mp3')) && available.includes('128k')) return '128k'
  return available[0] ?? 'flac'
}

function preferredAudioQualityForPath(pathname: string): MusicQuality | undefined {
  const ext = path.extname(pathname).toLowerCase()
  if (ext === '.flac') return 'flac'
  if (ext === '.mp3') return '320k'
  return undefined
}

function shouldAllowFullAudioFallback(request: Request): boolean {
  const userAgent = request.headers.get('user-agent')?.toLowerCase() ?? ''
  if (userAgent.includes('narjo')) return true
  const pathname = new URL(request.url).pathname.toLowerCase()
  return pathname.endsWith('.mp3') || pathname.endsWith('.flac')
}

function audioQualityFallbacks(
  preferredQuality: MusicQuality,
  musicInfo: MusicInfo,
  options: { allowFullFallback?: boolean } = {},
): MusicQuality[] {
  const fallback = qualityFallbacks(preferredQuality)
  if (!options.allowFullFallback) return fallback
  const available = availableSongQualities(musicInfo)
  const ordered = [preferredQuality, ...available, ...fallback].filter((quality, index, values) => values.indexOf(quality) === index)
  return ordered.length ? ordered : fallback
}

function logVirtualAudioEvent(
  event: string,
  request: Request,
  details: Record<string, unknown> = {},
  level: 'info' | 'error' = 'info',
): void {
  const url = new URL(request.url)
  logServiceEvent(event, {
    method: request.method,
    path: safeRequestPath(request.url),
    userAgent: request.headers.get('user-agent') ?? undefined,
    range: request.headers.get('range') ?? undefined,
    container: url.searchParams.get('Container') ?? url.searchParams.get('container') ?? undefined,
    audioCodec: url.searchParams.get('AudioCodec') ?? url.searchParams.get('audioCodec') ?? undefined,
    transcodingProtocol: url.searchParams.get('TranscodingProtocol') ?? url.searchParams.get('transcodingProtocol') ?? undefined,
    transcodingContainer: url.searchParams.get('TranscodingContainer') ?? url.searchParams.get('transcodingContainer') ?? undefined,
    deviceId: url.searchParams.get('DeviceId') ?? url.searchParams.get('deviceId') ?? undefined,
    playSessionId: url.searchParams.get('PlaySessionId') ?? url.searchParams.get('playSessionId') ?? undefined,
    ...details,
  }, level)
}

function summarizeAudioUrl(value: string): Record<string, unknown> {
  try {
    const url = new URL(value)
    return {
      protocol: url.protocol.replace(/:$/, ''),
      host: url.host,
      pathnameExt: path.extname(url.pathname).toLowerCase() || undefined,
    }
  } catch {
    return {
      pathnameExt: path.extname(value).toLowerCase() || undefined,
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function containerSupportsFlac(container: string): boolean {
  return container
    .split(',')
    .flatMap(item => item.split('|'))
    .map(item => item.trim())
    .includes('flac')
}

function availableSongQualities(musicInfo: MusicInfo): MusicQuality[] {
  const available = new Set((musicInfo.types ?? [])
    .map(item => item.type)
    .filter((quality): quality is MusicQuality => quality === 'flac' || quality === '320k' || quality === '128k'))
  const ordered = qualityFallbacks('flac').filter(quality => available.has(quality))
  return ordered.length ? ordered : qualityFallbacks('flac')
}

function audioContentTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.flac') return 'audio/flac'
  if (ext === '.m4a' || ext === '.mp4') return 'audio/mp4'
  if (ext === '.ogg') return 'audio/ogg'
  return 'audio/mpeg'
}

function playbackErrorMessage(error: unknown): string {
  if (error instanceof MusicUrlConfigError) {
    return `${error.message}. Set LX_MUSIC_SOURCE_SCRIPT to the LX source script URL; XMusic will simulate the source request handler and call the captured API shape directly.`
  }

  if (error instanceof MusicUrlResolveError) {
    const detail = error.attempts.map((attempt) => `${attempt.quality}: ${attempt.error}`).join('; ')
    if (error.attempts.some(attempt => attempt.error.includes('QQ encrypted audio requires a matching QQ Music local key'))) {
      return `${encryptedQQAudioRequiresKeyMessage} ${detail}`
    }
    return `Unable to resolve a playable music URL. ${detail}`
  }

  return error instanceof Error ? error.message : 'Unable to play track'
}

async function listVirtualPlaylists(request: Request, limit: number): Promise<QQPlaylistInfo[]> {
  const result: QQPlaylistInfo[] = []

  try {
    result.push(...await listQQUserPlaylistsWindow(request, limit))
  } catch {
    // User playlists require a valid QQ login; dynamic recommendation playlists still remain available.
  }

  result.unshift(defaultVirtualPlaylist('__daily__'), defaultVirtualPlaylist('__guess__'))

  const deduped = new Map<string, QQPlaylistInfo>()
  for (const playlist of result) {
    const key = playlist.id || playlist.name
    if (!deduped.has(key)) {
      rememberVirtualPlaylist(playlist)
      deduped.set(key, playlist)
    }
  }
  return [...deduped.values()].sort(compareVirtualPlaylists)
}

function defaultVirtualPlaylist(id: '__daily__' | '__guess__'): QQPlaylistInfo {
  const now = new Date().toISOString()
  return {
    source: 'tx',
    id,
    name: id === '__daily__' ? 'QQ 每日推荐' : 'QQ 猜你喜欢',
    author: 'QQ 音乐',
    total: 30,
    playCount: VIRTUAL_RECOMMENDATION_PLAYLIST_PLAY_COUNT,
    time: now,
  }
}

function compareVirtualPlaylists(a: QQPlaylistInfo, b: QQPlaylistInfo): number {
  const pinned = pinnedPlaylistRank(a) - pinnedPlaylistRank(b)
  if (pinned !== 0) return pinned
  const time = playlistTimeMs(b) - playlistTimeMs(a)
  if (time !== 0) return time
  return a.name.localeCompare(b.name)
}

function pinnedPlaylistRank(playlist: Pick<QQPlaylistInfo, 'id'>): number {
  if (playlist.id === '__daily__') return 0
  if (playlist.id === '__guess__') return 1
  return 2
}

async function listQQUserPlaylistsWindow(request: Request, limit: number): Promise<QQPlaylistInfo[]> {
  const playlists: QQPlaylistInfo[] = []
  let offset = 0
  const pageSize = QQ_PLAYLIST_PAGE_SIZE

  for (;;) {
    const result = await getQQUserPlaylists({
      cookie: qqCookieForRequest(request),
      offset,
      limit: pageSize,
    })
    playlists.push(...result.list)
    if (result.list.length === 0 || reachedFetchLimit(playlists.length, limit) || offset + result.list.length >= result.total) break
    offset += pageSize
  }

  return sliceToFetchLimit(playlists, limit)
}

async function listQQFavoriteSongs(request: Request, limit: number): Promise<WindowResult<MusicInfo>> {
  const cookie = qqCookieForRequest(request)
  const pageSize = QQ_SONG_PAGE_SIZE
  const first = await getQQFavoriteSongs({ cookie, page: 1, limit: pageSize }).catch(() => undefined)
  if (!first) return { items: [], total: 0, totalReliable: false, complete: false }

  const total = first.total
  const allPage = first.allPage ?? Math.ceil(total / first.limit)
  const requestedPages = Math.min(allPage, Math.ceil(finiteFetchCount(limit, total) / pageSize))
  const complete = !Number.isFinite(limit) || requestedPages >= allPage
  const remainingPages = Array.from({ length: Math.max(requestedPages - 1, 0) }, (_, index) => index + 2)
  const pageResults = await mapWithConcurrency(remainingPages, QQ_FAVORITES_MAX_CONCURRENCY, async (page) => {
    return getQQFavoriteSongs({ cookie, page, limit: pageSize }).catch(() => undefined)
  })
  const songs = [
    ...first.list,
    ...pageResults
      .filter((result): result is NonNullable<typeof first> => Boolean(result))
      .flatMap(result => result.list),
  ]

  const deduped = dedupeSongs(songs)
  return { items: sliceToFetchLimit(deduped, limit), total: total || deduped.length, totalReliable: true, rawCount: songs.length, complete }
}

function localFavoriteStateForRequest(request: Request): Map<string, ReturnType<typeof getFavoriteStatusForAccount> & { song?: MusicInfo }> {
  const account = authorizedLocalAccount(request)
  const local = listLocalFavoritesForAccount(account?.qqUin)
  return new Map(local.map(record => [`${record.source}:${record.songmid}`, {
    ...getFavoriteStatusForAccount(record.source, record.songmid, account?.qqUin),
    song: record,
  }]))
}

function applyLocalFavoriteState(remoteSongs: MusicInfo[], localState: Map<string, ReturnType<typeof getFavoriteStatusForAccount> & { song?: MusicInfo }>): MusicInfo[] {
  if (localState.size === 0) return remoteSongs

  const merged = new Map(remoteSongs.map(song => [`${song.source}:${song.songmid}`, song]))
  for (const [key, state] of localState) {
    if (state.desiredState === 'unfavorite') {
      merged.delete(key)
    } else if (state.desiredState === 'favorite' && state.song) {
      merged.set(key, state.song)
    }
  }
  return Array.from(merged.values())
}

async function searchQQMusicWindow(query: string, limit: number): Promise<WindowResult<MusicInfo>> {
  const songs: MusicInfo[] = []
  const pageSize = QQ_SEARCH_SONG_PAGE_SIZE
  let page = 1
  let allPage = 1
  let total = 0

  do {
    const result = await searchQQMusic(query, page, pageSize).catch(() => undefined)
    if (!result) break
    songs.push(...result.list)
    total = result.total
    allPage = result.allPage ?? Math.ceil(result.total / result.limit)
    if (result.list.length === 0 || reachedFetchLimit(songs.length, limit) || songs.length >= result.total) break
    page += 1
  } while (page <= allPage)

  const deduped = dedupeSongs(songs)
  return { items: sliceToFetchLimit(deduped, limit), total: total || deduped.length }
}

async function searchQQPlaylistsWindow(query: string, limit: number): Promise<WindowResult<QQPlaylistInfo>> {
  const playlists: QQPlaylistInfo[] = []
  const pageSize = QQ_PLAYLIST_PAGE_SIZE
  let page = 1
  let allPage = 1
  let total = 0

  do {
    const result = await searchQQPlaylists(query, page, pageSize).catch(() => undefined)
    if (!result) break
    playlists.push(...result.list)
    total = result.total
    allPage = result.allPage ?? Math.ceil(result.total / result.limit)
    if (result.list.length === 0 || reachedFetchLimit(playlists.length, limit) || playlists.length >= result.total) break
    page += 1
  } while (page <= allPage)

  const deduped = dedupePlaylists(playlists)
  return { items: sliceToFetchLimit(deduped, limit), total: total || deduped.length }
}

async function getQQPlaylistSongsWindow(id: string, limit: number): Promise<WindowResult<MusicInfo>> {
  const detail = await getQQPlaylistDetail(id).catch(() => undefined)
  const songs = dedupeSongs(detail?.list ?? [])
  return { items: sliceToFetchLimit(songs, limit), total: detail?.total ?? songs.length }
}

async function getQQRecommendationsWindow(request: Request, limit: number): Promise<WindowResult<MusicInfo>> {
  const songs: MusicInfo[] = []
  let remaining = finiteFetchCount(limit)

  while (remaining > 0) {
    const pageLimit = Math.min(QQ_SONG_PAGE_SIZE, remaining)
    const result = await getQQRecommendations({
      cookie: qqCookieForRequest(request),
      limit: pageLimit,
    }).catch(() => undefined)
    const nextSongs = result?.list ?? []
    songs.push(...nextSongs)
    if (nextSongs.length < pageLimit) break
    const uniqueCount = dedupeSongs(songs).length
    if (uniqueCount >= limit) break
    if (uniqueCount === songs.length - nextSongs.length) break
    remaining = limit - uniqueCount
  }

  const deduped = dedupeSongs(songs)
  return { items: sliceToFetchLimit(deduped, limit), total: deduped.length }
}

async function getQQDailyRecommendationsWindow(limit: number): Promise<WindowResult<MusicInfo>> {
  const result = await getQQDailyRecommendations({ limit: finiteFetchCount(limit) }).catch(() => undefined)
  const deduped = dedupeSongs(result?.list ?? [])
  return { items: sliceToFetchLimit(deduped, limit), total: result?.total ?? deduped.length }
}

function localPlayHistoryToEmbyItems(limit: number): any[] {
  const grouped = new Map<string, { song: PlayHistoryRecord; playCount: number; lastPlayedAt: string }>()
  for (const event of listPlayHistory(limit)) {
    const key = `${event.source}:${event.songmid}`
    const existing = grouped.get(key)
    if (existing) {
      existing.playCount += 1
      if (event.playedAt > existing.lastPlayedAt) existing.lastPlayedAt = event.playedAt
      continue
    }
    grouped.set(key, {
      song: event,
      playCount: 1,
      lastPlayedAt: event.playedAt,
    })
  }

  return [...grouped.values()].map(({ song, playCount, lastPlayedAt }) => {
    rememberVirtualSong(song)
    const item = songToEmbyItem(song)
    const userData = item.UserData as { PlayCount: number; LastPlayedDate?: string }
    userData.PlayCount = playCount
    userData.LastPlayedDate = lastPlayedAt
    return item
  })
}

function sortPlayedItems(items: any[], sortBy: string): any[] {
  const sortKeys = sortBy.split(',').map(item => item.trim().toLowerCase()).filter(Boolean)
  const result = [...items]
  if (sortKeys.includes('playcount')) {
    result.sort((a, b) => playCountOf(b) - playCountOf(a) || lastPlayedTimeOf(b) - lastPlayedTimeOf(a))
    return result
  }
  if (sortKeys.includes('dateplayed')) {
    result.sort((a, b) => lastPlayedTimeOf(b) - lastPlayedTimeOf(a) || playCountOf(b) - playCountOf(a))
  }
  return result
}

function playCountOf(item: any): number {
  const value = item?.UserData?.PlayCount
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function lastPlayedTimeOf(item: any): number {
  const value = item?.UserData?.LastPlayedDate ?? item?.UserData?.LastPlayedDateTicks ?? item?.DatePlayed
  if (typeof value !== 'string') return 0
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
}

function sortFavoriteItems(items: any[]): any[] {
  return items
    .map((item, index) => ({ item, index, time: favoriteItemTimeMs(item) }))
    .sort((a, b) => b.time - a.time || a.index - b.index)
    .map(entry => entry.item)
}

function favoriteItemTimeMs(item: any): number {
  for (const value of favoriteItemTimeCandidates(item)) {
    const time = parseTimeMs(value)
    if (time > 0) return time
  }
  return 0
}

function favoriteItemTimeCandidates(item: any): unknown[] {
  return [
    item?.[FAVORITE_SORT_TIME],
    item?.UserData?.FavoriteDate,
    item?.UserData?.DateFavorite,
    item?.UserData?.DateLastFavorite,
    item?.UserData?.LastPlayedDate,
    item?.DateFavorite,
    item?.DateLastFavorite,
    item?.DateModified,
    item?.DateCreated,
    item?.PremiereDate,
  ]
}

function parseTimeMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return normalizeTimestampMs(value)
  if (typeof value !== 'string' || !value.trim()) return 0
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return normalizeTimestampMs(numeric)
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
}

function normalizeTimestampMs(value: number): number {
  if (value <= 0) return 0
  return value < 100_000_000_000 ? value * 1000 : value
}

function calibrateFavoriteTotal(
  request: Request,
  page: PageParams,
  visibleCount: number,
  upstreamTotal: number | undefined,
  qqRawCount: number | undefined,
  qqComplete: boolean,
): number {
  const cacheKey = favoriteCacheKey(qqCookieForRequest(request))
  const realTotal = Number.isFinite(upstreamTotal) ? Math.max(upstreamTotal ?? 0, 0) : 0
  const previous = favoriteTotalCache.get(cacheKey)
  let total = previous ?? QQ_FAVORITES_DEFAULT_TOTAL

  if (qqComplete) {
    total = visibleCount
  } else if (qqRawCount !== undefined && previous === undefined && realTotal + qqRawCount > 0) {
    total = Math.max(total, realTotal + qqRawCount)
  }

  favoriteTotalCache.set(cacheKey, Math.max(total, visibleCount))
  return total
}

function favoriteSongsToAlbumItems(songs: MusicInfo[]) {
  const albums = new Map<string, MusicInfo[]>()
  for (const song of songs) {
    const albumId = song.albumId?.trim()
    const albumName = song.albumName?.trim()
    if (!albumId && !albumName) continue
    const key = albumId || normalizeText(albumName ?? '')
    if (!key) continue
    const existing = albums.get(key) ?? []
    existing.push(song)
    albums.set(key, existing)
  }

  return [...albums.entries()].map(([albumId, albumSongs]) => {
    const first = albumSongs[0]!
    rememberVirtualAlbumSongs(albumId, dedupeSongs(albumSongs))
    const artists = dedupeStrings(albumSongs.flatMap(song => splitArtists(song.singer)))
    return {
      Name: first.albumName || 'Unknown Album',
      ServerId: LOCAL_SERVER_ID,
      Id: albumVirtualId(albumId),
      Type: 'MusicAlbum',
      MediaType: 'Audio',
      IsFolder: true,
      AlbumArtist: artists[0] ?? '',
      AlbumArtists: artists,
      ArtistItems: artists.map((name, index) => ({ Name: name, Id: `${albumId}-album-artist-${index}` })),
      ChildCount: albumSongs.length,
      RecursiveItemCount: albumSongs.length,
      ImageTags: first.img ? { Primary: first.albumId || first.songmid } : {},
      UserData: {
        PlaybackPositionTicks: 0,
        PlayCount: 0,
        IsFavorite: true,
      },
    }
  })
}

function favoriteSongsToGenreItems(songs: MusicInfo[]) {
  const genreCounts = new Map<string, number>()
  for (const song of songs) {
    const genres = songGenres(song)
    for (const genre of genres.length > 0 ? genres : ['QQ Music']) {
      genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1)
    }
  }

  return [...genreCounts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => ({
      Name: name,
      ServerId: LOCAL_SERVER_ID,
      Id: genreVirtualId(name),
      Type: 'Genre',
      IsFolder: true,
      ChildCount: count,
      RecursiveItemCount: count,
      UserData: {
        PlaybackPositionTicks: 0,
        PlayCount: 0,
        IsFavorite: false,
      },
    }))
}

function songGenres(song: MusicInfo): string[] {
  const raw = song.raw
  if (!raw || typeof raw !== 'object') return []
  const record = raw as Record<string, unknown>
  const values = [
    record.genre,
    record.genres,
    record.genreName,
    record.genre_name,
  ]
  return dedupeStrings(values.flatMap(readGenreValues))
}

function readGenreValues(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.split(/[、,，/;；]+/).map(item => item.trim()).filter(Boolean)
  }
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (typeof item === 'string') return [item]
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>
      return typeof record.name === 'string' ? [record.name] : []
    }
    return []
  }).map(item => item.trim()).filter(Boolean)
}

function playlistToEmbyItem(playlist: QQPlaylistInfo) {
  const id = playlist.id === '__daily__'
    ? encodeVirtualId({ kind: 'qq-daily' })
    : playlist.id === '__guess__'
      ? encodeVirtualId({ kind: 'qq-guess' })
      : playlistVirtualId(playlist.id)
  const updatedAt = playlistUpdatedAt(playlist)
  return {
    Name: playlist.name,
    ServerId: LOCAL_SERVER_ID,
    Id: id,
    Type: 'Playlist',
    MediaType: 'Audio',
    IsFolder: true,
    DateCreated: updatedAt,
    PremiereDate: updatedAt,
    DateLastMediaAdded: updatedAt,
    RecursiveItemCount: playlist.total ?? 0,
    Overview: playlist.desc,
    ImageTags: playlist.img ? { Primary: playlist.id } : {},
    UserData: {
      PlaybackPositionTicks: 0,
      PlayCount: playlistPlayCountNumber(playlist),
      LastPlayedDate: updatedAt,
      IsFavorite: false,
      Played: playlistPlayCountNumber(playlist) > 0,
    },
  }
}

function isPinnedRecommendationPlaylistItem(item: { Id?: string }): boolean {
  const decoded = decodeVirtualId(item.Id ?? '')
  return decoded?.kind === 'qq-daily' || decoded?.kind === 'qq-guess'
}

function playlistUpdatedAt(playlist: QQPlaylistInfo): string {
  if (playlist.id === '__daily__' || playlist.id === '__guess__') return new Date().toISOString()
  const time = playlistTimeMs(playlist)
  return time > 0 ? new Date(time).toISOString() : '2000-01-01T00:00:00.000Z'
}

function playlistTimeMs(playlist: Pick<QQPlaylistInfo, 'time'>): number {
  if (!playlist.time) return 0
  const time = Date.parse(playlist.time)
  return Number.isFinite(time) ? time : 0
}

function playlistPlayCountNumber(playlist: Pick<QQPlaylistInfo, 'playCount'>): number {
  const raw = playlist.playCount ?? ''
  const normalized = raw.endsWith('亿')
    ? Number.parseFloat(raw) * 100000000
    : raw.endsWith('万')
      ? Number.parseFloat(raw) * 10000
      : Number.parseFloat(raw)
  return Number.isFinite(normalized) ? Math.floor(normalized) : 0
}

function virtualImageUrl(id: ReturnType<typeof decodeVirtualId>): string | undefined {
  if (!id) return undefined
  if (id.kind === 'qq-song') return loadVirtualSong(id.songmid)?.song.img || undefined
  if (id.kind === 'qq-playlist') return loadVirtualPlaylist(id.id)?.img || undefined
  if (id.kind === 'qq-album') return loadVirtualAlbumSongs(id.id)[0]?.img || undefined
  if (id.kind === 'qq-daily') return loadVirtualPlaylist('__daily__')?.img || undefined
  if (id.kind === 'qq-guess') return loadVirtualPlaylist('__guess__')?.img || undefined
  return undefined
}

function decodeClientVirtualId(id: string): VirtualId | undefined {
  return decodeVirtualId(id.startsWith('pl-') ? id.slice(3) : id)
}

function looksLikeQQSongMid(value: string): boolean {
  return /^[A-Za-z0-9]{14}$/.test(value) && /[A-Za-z]/.test(value)
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'undefined') return undefined
  return trimmed
}

function songToEmbyItem(song: MusicInfo, _playlistId?: string, isFavorite = false) {
  const artists = splitArtists(song.singer)
  const runtimeTicks = intervalToTicks(song.interval)
  const itemId = embyFacingSongItemId(song)
  const virtualId = songVirtualId(song)
  const mediaSource = songMediaSource(song, runtimeTicks, itemId, virtualId)
  const imageTag = songImageTag(song, itemId)
  const albumId = nonEmptyString(song.albumId)

  return compactRecord({
    Name: song.name,
    ServerId: LOCAL_SERVER_ID,
    Id: itemId,
    DateCreated: '2000-01-01T00:00:00.0000000Z',
    CanDelete: false,
    CanDownload: true,
    Container: mediaSource.Container,
    SortName: song.name,
    Path: mediaSource.Path,
    Size: mediaSource.Size,
    Bitrate: mediaSource.Bitrate,
    ProductionYear: songProductionYear(song),
    Type: 'Audio',
    MediaType: 'Audio',
    IsFolder: false,
    Album: song.albumName,
    AlbumId: albumId,
    AlbumPrimaryImageTag: imageTag,
    AlbumArtist: artists.join(','),
    AlbumArtists: artists.length ? [{ Name: artists.join(','), Id: `${song.songmid}-album-artist` }] : [],
    Artists: artists,
    ArtistItems: artists.map((name, index) => ({ Name: name, Id: `${song.songmid}-artist-${index}` })),
    Composers: [],
    RunTimeTicks: runtimeTicks,
    HasLyrics: true,
    MediaSources: [mediaSource],
    ImageTags: imageTag ? { Primary: imageTag } : {},
    UserData: {
      PlaybackPositionTicks: 0,
      PlayCount: 0,
      IsFavorite: isFavorite,
      Played: false,
    },
  })
}

function embyFacingSongItemId(song: MusicInfo): string {
  return validEmbyTrackMapping(song) ?? songVirtualId(song)
}

function favoriteSongToEmbyItem(song: MusicInfo, index: number) {
  const item = songToEmbyItem(song, undefined, true) as ReturnType<typeof songToEmbyItem> & {
    UserData: ReturnType<typeof songToEmbyItem>['UserData'] & { LastPlayedDate?: string }
  }
  const favoriteTime = qqFavoriteSongTimeMs(song)
  if (favoriteTime > 0) {
    const favoriteDate = new Date(favoriteTime).toISOString()
    item.DateCreated = favoriteDate
    item.UserData.LastPlayedDate = favoriteDate
  } else {
    Object.defineProperty(item, FAVORITE_SORT_TIME, {
      value: QQ_FAVORITE_ORDER_BASE_MS - index,
      enumerable: false,
    })
  }
  return item
}

function qqFavoriteSongTimeMs(song: MusicInfo): number {
  return parseTimeMs(readNestedRawValue(song.raw, [
    'favoriteTime',
    'favTime',
    'fav_time',
    'addTime',
    'add_time',
    'modifyTime',
    'modify_time',
    'ctime',
    'createTime',
    'create_time',
  ]))
}

function readNestedRawValue(raw: unknown, keys: string[]): unknown {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  for (const key of keys) {
    if (record[key] !== undefined) return record[key]
  }
  return undefined
}

function songMediaSource(song: MusicInfo, runtimeTicks?: number, itemId = songVirtualId(song), _virtualId = songVirtualId(song)) {
  const quality = preferredSongQuality(song)
  const bitrate = quality === 'flac' ? 900_000 : quality === '128k' ? 128_000 : 320_000
  const container = quality === 'flac' ? 'flac' : 'mp3'
  const codec = quality === 'flac' ? 'flac' : 'mp3'
  const subtitleDeliveryUrl = `/Items/${encodeURIComponent(itemId)}/Subtitles/1/Stream.js`
  const mediaStreams = compactRecord({
    Codec: codec,
    TimeBase: '1/44100',
    DisplayTitle: `${codec.toUpperCase()} stereo`,
    IsInterlaced: false,
    ChannelLayout: 'stereo',
    BitRate: bitrate,
    BitDepth: quality === 'flac' ? 16 : undefined,
    Channels: 2,
    SampleRate: 44100,
    IsDefault: true,
    IsForced: false,
    IsHearingImpaired: false,
    Type: 'Audio',
    Index: 0,
    IsExternal: false,
    IsTextSubtitleStream: false,
    SupportsExternalStream: false,
    Protocol: 'Http',
    ExtendedVideoType: 'None',
    ExtendedVideoSubType: 'None',
    ExtendedVideoSubTypeDescription: 'None',
    AttachmentSize: 0,
  })
  const subtitleStream = subtitleDeliveryUrl
    ? {
        Codec: 'lrc',
        DisplayTitle: 'QQ Music Lyrics',
        IsInterlaced: false,
        IsDefault: false,
        IsForced: false,
        IsHearingImpaired: false,
        Type: 'Subtitle',
        Index: 1,
        IsExternal: true,
        IsTextSubtitleStream: true,
        SupportsExternalStream: true,
        Protocol: 'Http',
        DeliveryMethod: 'External',
        DeliveryUrl: subtitleDeliveryUrl,
        Language: 'zho',
        AttachmentSize: 0,
      }
    : undefined

  return {
    Protocol: 'Http',
    Id: itemId,
    Path: `/Audio/${encodeURIComponent(itemId)}/universal`,
    Type: 'Default',
    Container: container,
    Size: readSongQualitySize(song, quality),
    Name: song.name,
    IsRemote: true,
    HasMixedProtocols: false,
    RunTimeTicks: runtimeTicks,
    SupportsTranscoding: true,
    SupportsDirectStream: true,
    SupportsDirectPlay: true,
    IsInfiniteStream: false,
    RequiresOpening: false,
    RequiresClosing: false,
    RequiresLooping: false,
    SupportsProbing: false,
    MediaStreams: subtitleStream ? [mediaStreams, subtitleStream] : [mediaStreams],
    Formats: [],
    Bitrate: bitrate,
    RequiredHttpHeaders: {},
    AddApiKeyToDirectStreamUrl: false,
    ReadAtNativeFramerate: false,
    DefaultAudioStreamIndex: 0,
    DefaultSubtitleStreamIndex: subtitleStream ? 1 : undefined,
    ItemId: itemId,
  }
}

function preferredSongQuality(song: MusicInfo): MusicQuality {
  return highestAvailableSongQuality(song)
}

function highestAvailableSongQuality(song: MusicInfo): MusicQuality {
  const available = song.types?.map(item => item.type) ?? []
  if (available.includes('flac')) return 'flac'
  if (available.includes('320k')) return '320k'
  return '128k'
}

function readSongQualitySize(song: MusicInfo, quality: MusicQuality): number | undefined {
  const sizeText = song.types?.find(item => item.type === quality)?.size
  if (!sizeText) return undefined
  const match = sizeText.match(/([\d.]+)\s*(B|KB|MB|GB)?/i)
  if (!match?.[1]) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value)) return undefined
  const unit = match[2]?.toUpperCase() ?? 'B'
  const multiplier = unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : unit === 'KB' ? 1024 : 1
  return Math.round(value * multiplier)
}

function songImageTag(song: MusicInfo, itemId = songVirtualId(song)): string | undefined {
  if (!song.img) return undefined
  return itemId
}

function songProductionYear(song: MusicInfo): number | undefined {
  const raw = song.raw
  if (!raw || typeof raw !== 'object') return undefined
  const value = readNestedString(raw as Record<string, unknown>, ['year'])
    ?? readNestedString(raw as Record<string, unknown>, ['time_public'])
    ?? readNestedString(raw as Record<string, unknown>, ['album', 'time_public'])
  const year = value?.match(/\d{4}/)?.[0]
  if (!year) return undefined
  const parsed = Number(year)
  return Number.isInteger(parsed) ? parsed : undefined
}

function readNestedString(record: Record<string, unknown>, keys: string[]): string | undefined {
  let current: unknown = record
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'string' && current.trim() ? current.trim() : undefined
}

async function fetchLyrics(songmid: string, playlistId?: string): Promise<string | undefined> {
  const stored = await loadOrFetchVirtualSong(songmid, playlistId)
  const cachedLyrics = await readCachedTrackLyrics({ source: 'tx', songmid })
  if (cachedLyrics) {
    void cleanupCachedLyricsIfEmbyHasLyrics(stored?.song).catch(() => undefined)
    return cachedLyrics
  }

  if (stored) {
    const embyLyrics = await fetchEmbyLyrics(stored.song)
    if (embyLyrics) {
      await cleanupCachedTrackLyrics({ source: 'tx', songmid }).catch(() => undefined)
      return embyLyrics
    }
  }

  const qqLyrics = await getQQLyrics(songmid, { songId: readQQSongId(stored?.song), timeoutMs: 10_000 })
  if (qqLyrics) await persistQQLyricsToLocalCache(stored?.song, qqLyrics).catch(() => undefined)
  return qqLyrics
}

function readQQSongId(song?: MusicInfo): number | undefined {
  const raw = song?.raw
  if (!raw || typeof raw !== 'object') return undefined
  const value = (raw as Record<string, unknown>).songId
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

async function readCachedTrackLyrics(song: Pick<MusicInfo, 'source' | 'songmid'>): Promise<string | undefined> {
  const qualities = qualityFallbacks('flac')
  for (const quality of qualities) {
    const file = getPlayableTrackFile(song.source, song.songmid, quality)
    const explicitLyrics = await readTextFileIfPresent(file?.lyricsPath)
    if (explicitLyrics) return normalizeLyrics(explicitLyrics)

    const audioPath = file?.finalPath ?? file?.rawPath
    const sidecar = audioPath ? await readTextFileIfPresent(replaceAudioExtension(audioPath, '.lrc')) : undefined
    if (sidecar) return normalizeLyrics(sidecar)
  }
  return undefined
}

async function persistQQLyricsToLocalCache(song: MusicInfo | undefined, lyrics: string): Promise<void> {
  if (!song || song.source !== 'tx') return
  const file = firstWritableTrackFile(song)
  const audioPath = file?.finalPath ?? file?.rawPath
  if (!file || !audioPath) return

  const lyricsPath = file.lyricsPath ?? replaceAudioExtension(audioPath, '.lrc')
  await mkdir(path.dirname(lyricsPath), { recursive: true })
  await writeFile(lyricsPath, `${normalizeLyrics(lyrics)}\n`, 'utf8')
  db.prepare(`
    UPDATE track_files
    SET lyrics_path = @lyricsPath,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({
    id: file.id,
    lyricsPath,
  })

  if (hasSyncableEmbyMedia(song)) {
    enqueueEmbyTrackSync({
      source: song.source,
      songmid: song.songmid,
      musicInfo: song,
    })
  }
}

function firstWritableTrackFile(song: Pick<MusicInfo, 'source' | 'songmid'>): ReturnType<typeof getPlayableTrackFile> {
  for (const quality of qualityFallbacks('flac')) {
    const file = getPlayableTrackFile(song.source, song.songmid, quality)
    if (file?.finalPath || file?.rawPath) return file
  }
  return undefined
}

async function cleanupCachedLyricsIfEmbyHasLyrics(song: MusicInfo | undefined): Promise<void> {
  if (!song) return
  const embyLyrics = await fetchEmbyLyrics(song).catch(() => undefined)
  if (embyLyrics) await cleanupCachedTrackLyrics(song)
}

async function cleanupCachedTrackLyrics(song: Pick<MusicInfo, 'source' | 'songmid'>): Promise<void> {
  const rows = db.prepare(`
    SELECT tf.id, tf.lyrics_path AS lyricsPath
    FROM track_files tf
    INNER JOIN tracks t ON t.id = tf.track_id
    WHERE t.source = ? AND t.songmid = ?
  `).all(song.source, song.songmid) as Array<{ id: number; lyricsPath?: string | null }>

  for (const row of rows) {
    if (row.lyricsPath) await rm(row.lyricsPath, { force: true }).catch(() => undefined)
    db.prepare(`
      UPDATE track_files
      SET lyrics_path = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(row.id)
  }
}

async function fetchEmbyLyrics(song: MusicInfo): Promise<string | undefined> {
  const mapped = await resolveEmbyTrackMapping(song)
  if (!mapped) return undefined

  const raw = await fetchEmbyRawLyrics(mapped)
  if (raw) return raw

  const json = await fetchEmbyStructuredLyrics(mapped)
  if (json) return json

  return undefined
}

async function fetchEmbyRawLyrics(itemId: string): Promise<string | undefined> {
  for (const path of [
    `/Items/${encodeURIComponent(itemId)}/Lyrics?format=lrc`,
    `/Items/${encodeURIComponent(itemId)}/Subtitles/2/Stream.lrc`,
  ]) {
    const text = await fetchEmbyText(path).catch(() => undefined)
    const normalized = text?.trim()
    if (normalized && !looksLikeJson(normalized)) return normalizeLyrics(normalized)
  }
  return undefined
}

async function fetchEmbyStructuredLyrics(itemId: string): Promise<string | undefined> {
  const data = await fetchEmbyJson<any>(`/Items/${encodeURIComponent(itemId)}/Lyrics`).catch(() => undefined)
  const text = typeof data?.Text === 'string' ? data.Text : undefined
  if (text?.trim()) return normalizeLyrics(text)

  const lines = Array.isArray(data?.Lyrics) ? data.Lyrics : Array.isArray(data?.Lines) ? data.Lines : []
  const lrc = structuredLyricsToLrc(lines)
  return lrc || undefined
}

function structuredLyricsToLrc(lines: unknown[]): string | undefined {
  const result: string[] = []
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue
    const record = line as Record<string, unknown>
    const text = typeof record.Text === 'string' ? record.Text : ''
    const start = Number(record.Start ?? record.StartPositionTicks ?? record.start)
    if (!text || !Number.isFinite(start)) continue
    result.push(`[${ticksToLrcTime(start)}]${text}`)
  }
  return result.length ? result.join('\n') : undefined
}

function ticksToLrcTime(ticks: number): string {
  const totalMs = Math.max(0, Math.floor(ticks / 10_000))
  const minutes = Math.floor(totalMs / 60_000)
  const seconds = Math.floor((totalMs % 60_000) / 1000)
  const centiseconds = Math.floor((totalMs % 1000) / 10)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trimStart()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

async function readTextFileIfPresent(filePath?: string): Promise<string | undefined> {
  if (!filePath) return undefined
  const text = await readFile(filePath, 'utf8').catch(() => undefined)
  return text?.trim() ? text : undefined
}

async function readCachedTrackCover(song: Pick<MusicInfo, 'source' | 'songmid'>): Promise<Response | undefined> {
  for (const quality of qualityFallbacks('flac')) {
    const file = getPlayableTrackFile(song.source, song.songmid, quality)
    const coverPath = file?.coverPath ?? await firstExistingImageSidecar(file?.finalPath ?? file?.rawPath)
    if (!coverPath) continue
    const fileStat = await stat(coverPath).catch(() => undefined)
    if (!fileStat) continue
    return new Response(fs.createReadStream(coverPath) as unknown as BodyInit, {
      status: 200,
      headers: {
        'content-type': imageContentTypeFromPath(coverPath),
        'content-length': String(fileStat.size),
        'cache-control': 'public, max-age=86400',
      },
    })
  }
  return undefined
}

async function firstExistingImageSidecar(audioPath?: string): Promise<string | undefined> {
  if (!audioPath) return undefined
  const dir = path.dirname(audioPath)
  for (const candidate of ['cover.jpg', 'cover.jpeg', 'cover.png']) {
    const filePath = path.join(dir, candidate)
    if (await stat(filePath).then(stat => stat.isFile()).catch(() => false)) return filePath
  }
  return undefined
}

function imageContentTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  return 'image/jpeg'
}

function replaceAudioExtension(filePath: string, ext: string): string {
  return filePath.slice(0, -path.extname(filePath).length) + ext
}

function normalizeLyrics(value: string): string {
  return value.replace(/\r\n?/g, '\n').trimEnd()
}

function parseLrcLyrics(value: string): Array<{ Start: number; Text: string }> {
  const lines: Array<{ Start: number; Text: string }> = []
  for (const rawLine of normalizeLyrics(value).split('\n')) {
    const matches = [...rawLine.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?]/g)]
    if (!matches.length) continue
    const text = rawLine.replace(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?]/g, '').trim()
    if (!text) continue
    for (const match of matches) {
      const minutes = Number(match[1])
      const seconds = Number(match[2])
      const fraction = match[3] ?? '0'
      if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) continue
      const milliseconds = Number(fraction.padEnd(3, '0').slice(0, 3))
      const startTicks = Math.round((minutes * 60 + seconds) * 10_000_000 + milliseconds * 10_000)
      lines.push({ Start: startTicks, Text: text })
    }
  }
  return lines.sort((a, b) => a.Start - b.Start)
}

function dedupeSongs(songs: MusicInfo[]): MusicInfo[] {
  const seen = new Set<string>()
  const result: MusicInfo[] = []
  for (const song of songs) {
    const key = `${song.source}:${song.songmid}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(song)
  }
  return result
}

function dedupePlaylists(playlists: QQPlaylistInfo[]): QQPlaylistInfo[] {
  const seen = new Set<string>()
  const result: QQPlaylistInfo[] = []
  for (const playlist of playlists) {
    const key = playlist.id || normalizeText(playlist.name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(playlist)
  }
  return result
}

function splitArtists(value?: string): string[] {
  return value
    ?.split(/[、,，/;；]+/)
    .map(item => item.trim())
    .filter(Boolean) ?? []
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const key = normalizeText(value)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function intervalToTicks(interval?: string): number | undefined {
  if (!interval) return undefined
  const parts = interval.split(':').map(Number)
  if (parts.some(part => !Number.isFinite(part))) return undefined
  const seconds = parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0]
  return seconds * 10_000_000
}

function numberParam(url: URL, key: string, fallback: number): number {
  const value = url.searchParams.get(key) ?? url.searchParams.get(key.toLowerCase())
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.trunc(parsed), MAX_EMBY_LIST_LIMIT) : fallback
}

function optionalNumberParam(url: URL, key: string): number | undefined {
  const value = url.searchParams.get(key) ?? url.searchParams.get(key.toLowerCase())
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.trunc(parsed), MAX_EMBY_LIST_LIMIT) : undefined
}

function startIndexParam(url: URL): number {
  const value = url.searchParams.get('StartIndex') ?? url.searchParams.get('startIndex')
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0
}

function requestPageParams(url: URL): PageParams {
  return {
    startIndex: startIndexParam(url),
    limit: optionalNumberParam(url, 'Limit'),
  }
}

function desiredFetchCount(page: PageParams): number {
  return page.limit === undefined
    ? Number.POSITIVE_INFINITY
    : page.startIndex + page.limit
}

function finiteFetchCount(limit: number, fallback = MAX_EMBY_LIST_LIMIT): number {
  return Number.isFinite(limit) ? limit : fallback
}

function cappedPageParams(page: PageParams, maxLimit: number): PageParams {
  return {
    startIndex: page.startIndex,
    limit: Math.min(page.limit ?? maxLimit, maxLimit),
  }
}

function reachedFetchLimit(count: number, limit: number): boolean {
  return Number.isFinite(limit) && count >= limit
}

function sliceToFetchLimit<T>(items: T[], limit: number): T[] {
  return Number.isFinite(limit) ? items.slice(0, limit) : items
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerCount = Math.min(Math.max(Math.trunc(concurrency), 1), items.length)
  await Promise.all(Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      results[index] = await mapper(items[index])
    }
  }))
  return results
}

async function timedResult<T>(promise: Promise<T>): Promise<TimedResult<T>> {
  const startedAt = Date.now()
  return {
    result: await promise,
    durationMs: Date.now() - startedAt,
  }
}

function pagedItemsResponse(items: any[], page: PageParams, totalRecordCount = items.length): Response {
  const end = page.limit === undefined ? undefined : page.startIndex + page.limit
  return Response.json({
    Items: items.slice(page.startIndex, end),
    TotalRecordCount: totalRecordCount,
  })
}

function filteredUpstreamTotal(upstream: { Items?: any[]; TotalRecordCount?: number } | undefined, filteredItems: any[]): number | undefined {
  const rawItems = upstream?.Items ?? []
  if (rawItems.length !== filteredItems.length) return filteredItems.length
  return upstream?.TotalRecordCount
}

function upstreamFirstPagedResponse(
  upstreamItems: any[],
  upstreamTotal: number | undefined,
  virtualItems: any[],
  virtualTotal: number,
  page: PageParams,
): Response {
  const realTotal = Number.isFinite(upstreamTotal) ? Math.max(upstreamTotal ?? 0, upstreamItems.length) : upstreamItems.length
  const total = realTotal + Math.max(virtualTotal, virtualItems.length)
  const desiredPageSize = page.limit ?? Math.max(upstreamItems.length + virtualItems.length, total)
  const pageItems: any[] = []

  if (page.startIndex < realTotal) {
    pageItems.push(...upstreamItems.slice(0, desiredPageSize))
  }

  const virtualStart = Math.max(page.startIndex - realTotal, 0)
  const virtualRemaining = Math.max(desiredPageSize - pageItems.length, 0)
  pageItems.push(...virtualItems.slice(virtualStart, virtualStart + virtualRemaining))

  return Response.json({
    Items: pageItems,
    TotalRecordCount: total,
  })
}

async function tryReadItemsResponse(
  request: Request,
  embyPath: string,
  pageOverride?: { startIndex?: number; limit?: number },
): Promise<{ Items?: any[]; TotalRecordCount?: number } | undefined> {
  try {
    return await fetchEmbyJson<{ Items?: any[]; TotalRecordCount?: number }>(`${embyPath}${await upstreamSearch(request, pageOverride)}`)
  } catch {
    return undefined
  }
}

async function upstreamSearch(request: Request, pageOverride?: { startIndex?: number; limit?: number }): Promise<string> {
  const url = new URL(request.url)
  for (const key of ['ParentId', 'parentId']) {
    const value = url.searchParams.get(key)
    if (value && isMusicLibraryId(value)) {
      const upstreamMusicLibraryId = await getDefaultUpstreamMusicLibraryId().catch(() => undefined)
      if (upstreamMusicLibraryId) {
        url.searchParams.set(key, upstreamMusicLibraryId)
      } else {
        url.searchParams.delete(key)
      }
    }
  }
  if (pageOverride?.startIndex !== undefined) {
    url.searchParams.set('StartIndex', String(pageOverride.startIndex))
    url.searchParams.delete('startIndex')
  }
  if (pageOverride?.limit !== undefined) {
    url.searchParams.set('Limit', String(pageOverride.limit))
    url.searchParams.delete('limit')
  }
  return url.search
}

function isMusicLibraryId(value: string): boolean {
  return value === MUSIC_LIBRARY_ID
}

function virtualGenreIds(url: URL): string[] {
  const raw = url.searchParams.get('GenreIds') ?? url.searchParams.get('genreIds') ?? ''
  return raw
    .split(',')
    .map(value => decodeVirtualId(value.trim()))
    .filter((value): value is Extract<VirtualId, { kind: 'qq-genre' }> => value?.kind === 'qq-genre')
    .map(value => value.id)
}

function parseIncludeTypes(includeTypes: string): Set<string> {
  return new Set(includeTypes.split(',').map(item => item.trim().toLowerCase()).filter(Boolean))
}

function shouldIncludeType(requestedTypes: Set<string>, type: string): boolean {
  return requestedTypes.size === 0 || requestedTypes.has(type)
}

function shouldIncludePlaylistTracks(requestedTypes: Set<string>): boolean {
  return requestedTypes.size === 0 || requestedTypes.has('audio') || requestedTypes.has('musicvideo')
}

function filterItemsByTypes(items: any[], requestedTypes: Set<string>): any[] {
  if (requestedTypes.size === 0) return items
  return items.filter(item => requestedTypes.has(String(item?.Type ?? '').toLowerCase()))
}

function matchesSongSearch(song: MusicInfo, searchTerm?: string | null): boolean {
  const normalizedSearchTerm = normalizeText(searchTerm?.trim() ?? '')
  if (!normalizedSearchTerm) return true
  return normalizeText(`${song.name} ${song.singer} ${song.albumName}`).includes(normalizedSearchTerm)
}

function hasEquivalentEmbySong(items: any[], song: MusicInfo): boolean {
  const songName = normalizeText(song.name)
  const songArtist = normalizeText(song.singer)
  return items.some(item => {
    if (String(item?.Type ?? '').toLowerCase() !== 'audio') return false
    const itemName = normalizeText(String(item?.Name ?? ''))
    const itemArtist = normalizeText(Array.isArray(item?.Artists) ? item.Artists.join(' ') : String(item?.Artist ?? ''))
    return itemName === songName && (!songArtist || itemArtist.includes(songArtist) || songArtist.includes(itemArtist))
  })
}

function hasEquivalentEmbyPlaylist(items: any[], name: string): boolean {
  const normalized = normalizeText(name)
  return items.some(item => String(item?.Type ?? '').toLowerCase() === 'playlist' && normalizeText(String(item?.Name ?? '')) === normalized)
}

function hasEquivalentEmbyAlbum(items: any[], name: string): boolean {
  const normalized = normalizeText(name)
  return items.some(item => String(item?.Type ?? '').toLowerCase() === 'musicalbum' && normalizeText(String(item?.Name ?? '')) === normalized)
}

function hasEquivalentEmbyItem(items: any[], item: any): boolean {
  const id = String(item?.Id ?? '')
  const name = normalizeText(String(item?.Name ?? ''))
  const type = String(item?.Type ?? '').toLowerCase()
  return items.some(existing => {
    if (id && String(existing?.Id ?? '') === id) return true
    return type === String(existing?.Type ?? '').toLowerCase() && name === normalizeText(String(existing?.Name ?? ''))
  })
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function parseFilters(filters: string): Set<string> {
  return new Set(filters.split(',').map(item => item.trim().toLowerCase()).filter(Boolean))
}

function requestFilters(url: URL): Set<string> {
  const filters = parseFilters(url.searchParams.get('Filters') ?? url.searchParams.get('filters') ?? '')
  const favorite = url.searchParams.get('isFavorite') ?? url.searchParams.get('IsFavorite')
  if (favorite?.toLowerCase() === 'true') filters.add('isfavorite')
  return filters
}

function hasVirtualArtistFilter(url: URL): boolean {
  return virtualArtistNames(url).length > 0
}

function virtualArtistNames(url: URL): string[] {
  const values = [
    url.searchParams.get('ArtistIds'),
    url.searchParams.get('artistIds'),
    url.searchParams.get('AlbumArtistIds'),
    url.searchParams.get('albumArtistIds'),
  ].filter((value): value is string => Boolean(value))
  return dedupeStrings(values.flatMap(value => value.split(',').flatMap(readVirtualArtistNames)))
}

function readVirtualArtistNames(value: string): string[] {
  const decoded = decodeURIComponent(value)
  return decoded
    .split(/[,/]/)
    .map(part => part.match(/^(.+)-(?:album-)?artist-\d+$/i)?.[1])
    .filter((songmid): songmid is string => Boolean(songmid))
    .flatMap(songmid => {
      const song = loadVirtualSong(songmid)?.song
      return song ? splitArtists(song.singer) : [songmid]
    })
}

function favoriteCacheKey(cookie?: string): string {
  return crypto.createHash('sha1').update(cookie ?? '').digest('hex')
}

function wantsRawLyrics(request: Request): boolean {
  const accept = request.headers.get('accept')?.toLowerCase() ?? ''
  const format = new URL(request.url).searchParams.get('format')?.toLowerCase()
  return format === 'lrc' || format === 'text' || accept.includes('text/plain')
}

function subtitleStreamFormat(path: string): string {
  const pathname = path.split('?', 1)[0] ?? path
  return pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? 'lrc'
}

function subtitleContentType(format: string): string {
  if (format === 'js' || format === 'json') return 'application/json; charset=utf-8'
  if (format === 'vtt') return 'text/vtt; charset=utf-8'
  if (format === 'srt') return 'application/x-subrip; charset=utf-8'
  return 'text/plain; charset=utf-8'
}

function formatSubtitleStream(lyrics: string, format: string): string {
  if (format === 'js' || format === 'json') return JSON.stringify({ TrackEvents: lrcToTrackEvents(lyrics) })
  return lyrics
}

function lrcToTrackEvents(value: string): Array<{ Id: string; Text: string; StartPositionTicks: number; EndPositionTicks: number }> {
  const lines = parseLrcLyrics(value)
  return lines.map((line, index) => ({
    Id: String(index + 1),
    Text: line.Text,
    StartPositionTicks: line.Start,
    EndPositionTicks: lines[index + 1]?.Start ?? line.Start + 30_000_000,
  }))
}

function subsonicResponse(request: Request, body: Record<string, unknown>, status = 200): Response {
  const payload = {
    'subsonic-response': {
      status: status >= 400 ? 'failed' : 'ok',
      version: '1.16.1',
      type: 'x-music',
      serverVersion: '0.1.0',
      ...body,
    },
  }

  return wantsSubsonicXml(request)
    ? markRequestSource(new Response(subsonicXml(payload), {
      status,
      headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-store' },
    }), 'local')
    : markRequestSource(Response.json(payload, { status, headers: { 'cache-control': 'no-store' } }), 'local')
}

function wantsSubsonicXml(request: Request): boolean {
  const url = new URL(request.url)
  const format = (url.searchParams.get('f') ?? url.searchParams.get('format') ?? '').toLowerCase()
  const accept = request.headers.get('accept')?.toLowerCase() ?? ''
  return format === 'xml' || (!format && accept.includes('xml') && !accept.includes('json'))
}

function songToSubsonicChild(song: MusicInfo): Record<string, unknown> {
  const runtimeTicks = intervalToTicks(song.interval)
  const duration = runtimeTicks ? Math.round(runtimeTicks / 10_000_000) : undefined
  return compactRecord({
    id: songVirtualId(song),
    title: song.name,
    artist: song.singer,
    album: song.albumName,
    duration,
    isDir: false,
    type: 'music',
    suffix: preferredSongQuality(song) === 'flac' ? 'flac' : 'mp3',
    contentType: preferredSongQuality(song) === 'flac' ? 'audio/flac' : 'audio/mpeg',
    path: `/Audio/${encodeURIComponent(songVirtualId(song))}/universal`,
  })
}

function subsonicStructuredLyrics(lyrics: string): Record<string, unknown> {
  return {
    displayArtist: '',
    displayTitle: '',
    lang: 'zho',
    synced: true,
    line: parseLrcLyrics(lyrics).map(line => ({
      start: Math.floor(line.Start / 10_000),
      value: line.Text,
    })),
  }
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== ''))
}

function subsonicXml(payload: Record<string, unknown>): string {
  const body = Object.entries(payload).map(([key, value]) => xmlNode(key, value)).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>${body}`
}

function xmlNode(key: string, value: unknown): string {
  if (Array.isArray(value)) return value.map(item => xmlNode(key, item)).join('')
  if (!value || typeof value !== 'object') return `<${key}>${escapeXml(String(value ?? ''))}</${key}>`

  const attributes: string[] = []
  const children: string[] = []
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(childValue) || (childValue && typeof childValue === 'object')) {
      children.push(xmlNode(childKey, childValue))
    } else if (childValue !== undefined) {
      attributes.push(`${childKey}="${escapeXml(String(childValue))}"`)
    }
  }
  const open = attributes.length ? `<${key} ${attributes.join(' ')}>` : `<${key}>`
  return `${open}${children.join('')}</${key}>`
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
