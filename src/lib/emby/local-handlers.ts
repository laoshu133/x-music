import { ensureTrack, getPlayableTrackFile, insertPlayEvent, listPlayHistory, upsertTrackFileStatus } from '@/lib/cache/store'
import { createUpstreamTeeResponse, streamLocalFile } from '@/lib/cache/stream'
import { qualityFallbacks, resolveMusicUrlWithFallback } from '@/lib/music-url/resolve'
import {
  getQQPlaylistDetail,
  getQQFavoriteSongs,
  getQQLoginState,
  getQQRecommendations,
  getQQUserPlaylists,
  searchQQMusic,
  searchQQPlaylists,
  syncQQPlayHistoryBestEffort,
} from '@/lib/qq'
import type { MusicInfo, MusicQuality, PlayHistoryRecord, QQPlaylistInfo } from '@/lib/types'
import { enqueueEmbyTrackSync } from './sync'
import { markRequestSource } from '@/lib/request-log'
import { albumVirtualId, decodeVirtualId, encodeVirtualId, genreVirtualId, playlistVirtualId, songVirtualId, type VirtualId } from './virtual-ids'
import {
  loadVirtualAlbumSongs,
  loadVirtualPlaylist,
  loadVirtualSong,
  rememberVirtualAlbumSongs,
  rememberVirtualPlaylist,
  rememberVirtualSong,
} from './virtual-store'
import { getRemoteMapping, upsertRemoteMapping } from '@/lib/db/remote-mappings'
import { fetchEmbyJson, searchEmbyAudioByName, searchEmbyPlaylistByName } from './upstream-api'
import { proxyToUpstreamEmby } from './upstream-proxy'
import { getAccountByEmbyUsername, getAccountByEmbyUserId, listAccounts, type AccountRecord } from '@/lib/db/accounts'
import { ensureUpstreamEmbyUserForAccount } from './auth'
import crypto from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { createLocalAccessToken, readEmbyAccessToken } from './tokens'

const LOCAL_SERVER_ID = 'mixmusic'
const MAX_EMBY_LIST_LIMIT = 1000
const QQ_SONG_PAGE_SIZE = 100
const QQ_PLAYLIST_PAGE_SIZE = 50

export async function handleLocalEmbyRequest(request: Request, embyPath: string): Promise<Response | undefined> {
  if (request.method === 'GET' && embyPath === '/System/Info/Public') {
    return Response.json({
      LocalAddress: '',
      ServerName: 'miXmusic',
      Version: '0.1.0',
      ProductName: 'miXmusic Emby Gateway',
      Id: LOCAL_SERVER_ID,
      StartupWizardCompleted: true,
    })
  }

  if (request.method === 'POST' && embyPath === '/Users/AuthenticateByName') {
    return handleAuthenticateByName(request)
  }

  if (request.method === 'GET' && embyPath === '/Users/Public') {
    return handlePublicUsers()
  }

  if (request.method === 'GET' && embyPath === '/System/Endpoint') {
    return Response.json({ IsLocal: true, IsInNetwork: true })
  }

  if (request.method === 'GET' && isUserRequest(embyPath)) {
    if (!isAuthorizedLocalRequest(request)) return unauthorizedResponse()
    return handleUserRequest(embyPath)
  }

  if (request.method === 'GET' && isUserViewsRequest(embyPath)) {
    if (!isAuthorizedLocalRequest(request)) return unauthorizedResponse()
    return handleUserViewsRequest(embyPath)
  }

  if (request.method === 'GET' && embyPath === '/mixmusic/health') {
    return Response.json({ ok: true, service: 'mixmusic-emby-gateway' })
  }

  if (request.method === 'POST' && isPlaybackReportRequest(embyPath)) {
    if (!isAuthorizedLocalRequest(request)) return unauthorizedResponse()
    return handlePlaybackReportRequest(request, embyPath)
  }

  if (request.method === 'GET' && isLocalEmptyCollectionRequest(embyPath)) {
    if (!isAuthorizedLocalRequest(request)) return unauthorizedResponse()
    return handleCollectionRequest(request, embyPath)
  }

  if (request.method === 'GET' && isImageRequest(embyPath)) {
    return handleImageRequest(request, embyPath)
  }

  if (request.method === 'GET' && isItemRequest(embyPath)) {
    if (!isAuthorizedLocalRequest(request)) return unauthorizedResponse()
    return handleItemRequest(embyPath)
  }

  if (request.method === 'GET' && isItemsRequest(embyPath)) {
    if (!isAuthorizedLocalRequest(request)) return unauthorizedResponse()
    return handleItemsRequest(request, embyPath)
  }

  if (request.method === 'GET' && isPlaylistItemsRequest(embyPath)) {
    if (!isAuthorizedLocalRequest(request)) return unauthorizedResponse()
    return handlePlaylistItemsRequest(request, embyPath)
  }

  if ((request.method === 'GET' || request.method === 'HEAD') && isAudioRequest(embyPath)) {
    if (!isAuthorizedLocalRequest(request)) return unauthorizedResponse()
    return handleAudioRequest(request, embyPath)
  }

  return undefined
}

async function handleAuthenticateByName(request: Request): Promise<Response> {
  const body = await request.json().catch(() => undefined) as { Username?: unknown; Pw?: unknown; Password?: unknown } | undefined
  const username = typeof body?.Username === 'string' ? body.Username.trim() : ''
  const password = typeof body?.Pw === 'string'
    ? body.Pw
    : typeof body?.Password === 'string'
      ? body.Password
      : ''
  const account = getAccountByEmbyUsername(username)
  if (!account || password !== account.embyPassword) {
    return Response.json({ error: 'Invalid username or password' }, { status: 401 })
  }

  const upstreamAccount = await ensureUpstreamEmbyUserForAccount(account).catch(() => account)
  const accessToken = createLocalAccessToken(upstreamAccount)
  return Response.json({
    User: {
      Name: upstreamAccount.embyUsername,
      ServerId: LOCAL_SERVER_ID,
      Id: localUserId(upstreamAccount),
      HasPassword: true,
      HasConfiguredPassword: true,
      HasConfiguredEasyPassword: false,
      EnableAutoLogin: false,
      Policy: {
        IsAdministrator: false,
        IsHidden: false,
        IsDisabled: false,
        EnableRemoteControlOfOtherUsers: false,
        EnableSharedDeviceControl: true,
        EnableRemoteAccess: true,
      },
    },
    SessionInfo: {},
    AccessToken: accessToken,
    ServerId: LOCAL_SERVER_ID,
  })
}

function authorizedLocalAccount(request: Request): AccountRecord | undefined {
  const token = readEmbyAccessToken(request)
  if (!token) return undefined
  return listAccounts().find(account => token === createLocalAccessToken(account))
}

function isAuthorizedLocalRequest(request: Request): boolean {
  return Boolean(authorizedLocalAccount(request))
}

function unauthorizedResponse(): Response {
  return Response.json({ error: 'Unauthorized' }, { status: 401 })
}

function localUserId(account: AccountRecord): string {
  return account.embyUserId ?? crypto.createHash('sha1').update(`${LOCAL_SERVER_ID}:${account.qqUin}:${account.embyUsername}`).digest('hex')
}

function handlePublicUsers(): Response {
  return Response.json(listAccounts().map(localUser))
}

function handleUserRequest(path: string): Response | undefined {
  const requestedUserId = decodeURIComponent(path.split('/')[2] ?? '')
  const account = requestedUserId ? findAccountByLocalOrUpstreamUserId(requestedUserId) : undefined
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

function isUserRequest(path: string): boolean {
  return /^\/Users\/[^/]+$/i.test(path)
}

function isUserViewsRequest(path: string): boolean {
  return /^\/Users\/[^/]+\/Views$/i.test(path)
}

function handleUserViewsRequest(path: string): Response {
  const requestedUserId = decodeURIComponent(path.split('/')[2] ?? '')
  const account = findAccountByLocalOrUpstreamUserId(requestedUserId)
  if (!account) {
    return Response.json({ error: 'User not found' }, { status: 404 })
  }

  return Response.json({
    Items: [{
      Name: 'miXmusic',
      ServerId: LOCAL_SERVER_ID,
      Id: 'mixmusic-music',
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

function isItemsRequest(path: string): boolean {
  return /^\/Users\/[^/]+\/Items$/i.test(path) || path === '/Items'
}

function isItemRequest(path: string): boolean {
  return /^\/Users\/[^/]+\/Items\/[^/]+$/i.test(path) || /^\/Items\/[^/]+$/i.test(path)
}

function isPlaylistItemsRequest(path: string): boolean {
  return /^\/Playlists\/[^/]+\/Items$/i.test(path) || /^\/Users\/[^/]+\/Items\/[^/]+\/Items$/i.test(path)
}

function isAudioRequest(path: string): boolean {
  return /^\/Audio\/[^/]+\/(?:universal|stream)$/i.test(path)
}

function isPlaybackReportRequest(path: string): boolean {
  return /^\/Sessions\/Playing(?:\/(?:Progress|Stopped))?$/i.test(path)
}

function isLocalEmptyCollectionRequest(path: string): boolean {
  return /^\/Users\/[^/]+\/(?:Albums|Artists|AlbumArtists|Genres|FavoriteItems|Items\/Latest|Items\/Resume)$/i.test(path)
    || /^\/(?:Albums|Artists|AlbumArtists|Genres|MusicGenres|Years|Studios|Persons)$/i.test(path)
}

function isGenresCollectionPath(path: string): boolean {
  return /^\/Users\/[^/]+\/Genres$/i.test(path) || /^\/(?:Genres|MusicGenres)$/i.test(path)
}

function isImageRequest(path: string): boolean {
  return /^\/Items\/[^/]+\/Images\/[^/]+$/i.test(path)
    || /^\/Users\/[^/]+\/Images\/[^/]+$/i.test(path)
}

function emptyItemsResponse(): Response {
  return Response.json({ Items: [], TotalRecordCount: 0 })
}

function emptyImageResponse(): Response {
  return new Response(null, { status: 204 })
}

async function handleImageRequest(request: Request, embyPath: string): Promise<Response> {
  const itemId = extractImageItemId(embyPath)
  if (!itemId) return emptyImageResponse()
  if (itemId === 'mixmusic-music') return emptyImageResponse()

  const decoded = decodeVirtualId(itemId)
  if (!decoded) return proxyToUpstreamEmby(request, embyPath)

  const imageUrl = virtualImageUrl(decoded)
  if (!imageUrl) return emptyImageResponse()

  const response = await fetch(imageUrl, {
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  if (!response?.ok) return emptyImageResponse()

  return markRequestSource(new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: imageResponseHeaders(response.headers),
  }), 'upstream')
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
  const filters = parseFilters(url.searchParams.get('Filters') ?? url.searchParams.get('filters') ?? '')
  const limit = numberParam(url, 'Limit', 500)
  const startIndex = startIndexParam(url)

  if (searchTerm?.trim()) {
    const upstream = await tryReadItemsResponse(request, embyPath)
    const upstreamItems = filterItemsByTypes(upstream?.Items ?? [], requestedTypes)
    const virtualItems: any[] = []

    if (shouldIncludeType(requestedTypes, 'audio')) {
      const songs = await searchQQMusicWindow(searchTerm.trim(), startIndex + limit)
      virtualItems.push(...dedupeSongs(songs)
        .filter(song => !hasEquivalentEmbySong(upstreamItems, song))
        .map(song => {
          rememberVirtualSong(song)
          return songToEmbyItem(song)
        }))
    }

    if (shouldIncludeType(requestedTypes, 'playlist')) {
      const playlists = await searchQQPlaylistsWindow(searchTerm.trim(), startIndex + limit)
      virtualItems.push(...playlists
        .filter(playlist => !hasEquivalentEmbyPlaylist(upstreamItems, playlist.name))
        .map(playlistToEmbyItem))
    }

    const merged = [...upstreamItems, ...virtualItems]
    return pagedItemsResponse(merged, startIndex, limit)
  }

  if (filters.has('isplayed') && shouldIncludeType(requestedTypes, 'audio')) {
    const upstream = await tryReadItemsResponse(request, embyPath)
    const upstreamItems = filterItemsByTypes(upstream?.Items ?? [], requestedTypes)
    const localItems = localPlayHistoryToEmbyItems(limit + startIndex)
      .filter(item => !hasEquivalentEmbyItem(upstreamItems, item))
    const merged = sortPlayedItems([...upstreamItems, ...localItems], url.searchParams.get('SortBy') ?? url.searchParams.get('sortBy') ?? '')
    return pagedItemsResponse(merged, startIndex, limit)
  }

  if (filters.has('isfavorite') && shouldIncludeType(requestedTypes, 'audio')) {
    const upstream = await tryReadItemsResponse(request, embyPath)
    const upstreamItems = filterItemsByTypes(upstream?.Items ?? [], requestedTypes)
    const favorites = await listQQFavoriteSongs(request, startIndex + limit)
    const virtualItems = favorites
      .filter(song => !hasEquivalentEmbySong(upstreamItems, song))
      .map(song => {
        rememberVirtualSong(song)
        return songToEmbyItem(song, undefined, true)
      })
    const merged = [...upstreamItems, ...virtualItems]
    return pagedItemsResponse(merged, startIndex, limit)
  }

  if (parentId === 'mixmusic-music' && requestedTypes.has('musicalbum')) {
    const upstream = await tryReadItemsResponse(request, embyPath)
    const upstreamItems = filterItemsByTypes(upstream?.Items ?? [], requestedTypes)
    const favorites = await listQQFavoriteSongs(request, startIndex + limit)
    const virtualAlbums = favoriteSongsToAlbumItems(favorites)
      .filter(album => !hasEquivalentEmbyAlbum(upstreamItems, album.Name))
    const merged = [...upstreamItems, ...virtualAlbums]
    return pagedItemsResponse(merged, startIndex, limit)
  }

  if (requestedTypes.has('playlist')) {
    const upstream = await tryReadItemsResponse(request, embyPath)
    const playlists = await listVirtualPlaylists(request, startIndex + limit)
    const upstreamItems = upstream?.Items ?? []
    const virtualItems = playlists
      .filter(playlist => !hasEquivalentEmbyPlaylist(upstreamItems, playlist.name))
      .map(playlistToEmbyItem)
    const merged = [...upstreamItems, ...virtualItems]
    return pagedItemsResponse(merged, startIndex, limit)
  }

  if (parentId === 'mixmusic-music') {
    const upstream = await tryReadItemsResponse(request, embyPath)
    return upstream ? Response.json(upstream) : emptyItemsResponse()
  }

  return undefined
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

  const limit = numberParam(url, 'Limit', 500)
  const startIndex = startIndexParam(url)
  const favorites = await listQQFavoriteSongs(request, startIndex + limit)
  const qqGenres = favoriteSongsToGenreItems(favorites)
  const upstreamItems = upstream?.Items ?? []
  const merged = [
    ...upstreamItems,
    ...qqGenres.filter(genre => !upstreamItems.some(item => normalizeText(String(item?.Name ?? '')) === normalizeText(genre.Name))),
  ]
  return pagedItemsResponse(merged, startIndex, limit)
}

async function handlePlaybackReportRequest(request: Request, embyPath: string): Promise<Response | undefined> {
  const body = await request.clone().json().catch(() => undefined) as { ItemId?: unknown } | undefined
  const itemId = typeof body?.ItemId === 'string' ? body.ItemId : ''
  const decoded = decodeVirtualId(itemId)
  if (!decoded || decoded.kind !== 'qq-song') return undefined

  const stored = loadVirtualSong(decoded.songmid)
  if (stored && /\/Stopped$/i.test(embyPath)) {
    const quality = playableQualityForSong(stored.song) ?? '320k'
    const track = ensureTrack(stored.song)
    insertPlayEvent(track.id, quality)
    enqueueEmbyTrackSync({
      source: stored.song.source,
      songmid: stored.song.songmid,
      playlistId: decoded.playlistId ?? stored.playlistId,
      musicInfo: stored.song,
    })
  }

  return new Response(null, { status: 204 })
}

function handleItemRequest(embyPath: string): Response | undefined {
  const itemId = extractItemId(embyPath)
  if (!itemId) return undefined

  const decoded = decodeVirtualId(itemId)
  if (!decoded || decoded.kind !== 'qq-song') return undefined

  const stored = loadVirtualSong(decoded.songmid)
  if (!stored) {
    return Response.json({ error: 'Virtual QQ song metadata is not cached. Search or open the virtual playlist again.' }, { status: 404 })
  }

  return Response.json(songToEmbyItem(stored.song, decoded.playlistId ?? stored.playlistId))
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
  const limit = numberParam(url, 'Limit', 500)
  const startIndex = startIndexParam(url)

  let songs: MusicInfo[] = []
  if (decoded.kind === 'qq-playlist') {
    songs = await getQQPlaylistSongsWindow(decoded.id, startIndex + limit)
  } else if (decoded.kind === 'qq-album') {
    songs = loadVirtualAlbumSongs(decoded.id)
  } else if (decoded.kind === 'qq-guess') {
    songs = await getQQRecommendationsWindow(request, startIndex + limit)
  } else if (decoded.kind === 'qq-daily') {
    songs = await getQQRecommendationsWindow(request, startIndex + limit)
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
  return pagedItemsResponse(items, startIndex, limit)
}

async function handleAudioRequest(request: Request, embyPath: string): Promise<Response | undefined> {
  const itemId = decodeURIComponent(embyPath.split('/')[2] ?? '')
  const decoded = decodeVirtualId(itemId)
  if (!decoded || decoded.kind !== 'qq-song') return undefined

  const stored = loadVirtualSong(decoded.songmid)
  if (!stored) {
    return Response.json({ error: 'Virtual QQ song metadata is not cached. Search or open the virtual playlist again.' }, { status: 404 })
  }

  const musicInfo = stored.song
  if (request.method === 'HEAD') {
    const playableHeaders = await virtualAudioHeadHeaders(musicInfo)
    return markRequestSource(new Response(null, { status: 200, headers: playableHeaders }), playableHeaders.get('content-length') ? 'local' : 'upstream')
  }

  const mapped = getRemoteMapping({ localType: 'track', localKey: `${musicInfo.source}:${musicInfo.songmid}`, remote: 'emby' })?.remoteId
    ?? await searchEmbyAudioByName(musicInfo).catch(() => undefined)
  if (mapped) {
    upsertRemoteMapping({
      localType: 'track',
      localKey: `${musicInfo.source}:${musicInfo.songmid}`,
      remote: 'emby',
      remoteId: mapped,
      raw: musicInfo,
    })
    const action = embyPath.split('/')[3] ?? 'universal'
    return proxyToUpstreamEmby(request, `/Audio/${encodeURIComponent(mapped)}/${action}`)
  }

  const preferredQuality: MusicQuality = 'flac'
  const playableFile = qualityFallbacks(preferredQuality)
    .map((quality) => getPlayableTrackFile(musicInfo.source, musicInfo.songmid, quality))
    .find((file) => file !== undefined)
  const localPath = playableFile?.finalPath ?? playableFile?.rawPath

  if (playableFile && localPath) {
    const track = ensureTrack(musicInfo)
    insertPlayEvent(track.id, playableFile.quality)
    syncQQPlayHistoryFromStoredUrlBestEffort(request, musicInfo, playableFile.quality)
    enqueueEmbyTrackSync({
      source: musicInfo.source,
      songmid: musicInfo.songmid,
      playlistId: decoded.playlistId ?? stored.playlistId,
      musicInfo,
    })
    return markRequestSource(await streamLocalFile(localPath, request), 'local')
  }

  const track = ensureTrack(musicInfo)
  upsertTrackFileStatus(track.id, preferredQuality, 'resolving_url')
  const resolved = await resolveMusicUrlWithFallback(musicInfo, preferredQuality)
  insertPlayEvent(track.id, resolved.quality)
  syncQQPlayHistoryBestEffort({
    cookie: qqCookieForRequest(request),
    musicInfo,
    quality: resolved.quality,
    playUrl: resolved.url,
  })
  enqueueEmbyTrackSync({
    source: musicInfo.source,
    songmid: musicInfo.songmid,
    playlistId: decoded.playlistId ?? stored.playlistId,
    musicInfo,
  })
  const { response, completion } = await createUpstreamTeeResponse(resolved.url, track, resolved.quality, request)
  completion.catch((error: unknown) => {
    upsertTrackFileStatus(track.id, resolved.quality, 'failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  })
  return markRequestSource(response, 'upstream')
}

function syncQQPlayHistoryFromStoredUrlBestEffort(request: Request, musicInfo: MusicInfo, quality: MusicQuality): void {
  const cookie = qqCookieForRequest(request)
  try {
    if (!getQQLoginState({ cookie })) return
  } catch (error) {
    console.warn(
      `QQ play history sync skipped for ${musicInfo.songmid}: ${error instanceof Error ? error.message : String(error)}`,
    )
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
    console.warn(
      `QQ play history URL resolve failed for ${musicInfo.songmid}: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
}

function qqCookieForRequest(request: Request): string | undefined {
  return authorizedLocalAccount(request)?.qqCookie
    ?? request.headers.get('x-qq-music-cookie')
    ?? undefined
}

async function virtualAudioHeadHeaders(musicInfo: MusicInfo): Promise<Headers> {
  const playableFile = qualityFallbacks('flac')
    .map((quality) => getPlayableTrackFile(musicInfo.source, musicInfo.songmid, quality))
    .find((file) => file !== undefined)
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
    'cache-control': 'no-store',
  })
}

function playableQualityForSong(musicInfo: MusicInfo): MusicQuality | undefined {
  return qualityFallbacks('flac')
    .find((quality) => getPlayableTrackFile(musicInfo.source, musicInfo.songmid, quality) !== undefined)
}

function audioContentTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.flac') return 'audio/flac'
  if (ext === '.m4a' || ext === '.mp4') return 'audio/mp4'
  if (ext === '.ogg') return 'audio/ogg'
  return 'audio/mpeg'
}

async function listVirtualPlaylists(request: Request, limit: number): Promise<QQPlaylistInfo[]> {
  const result: QQPlaylistInfo[] = []

  try {
    result.push(...await listQQUserPlaylistsWindow(request, limit))
  } catch {
    // User playlists require a valid QQ login; dynamic recommendation playlists still remain available.
  }

  result.push({
    source: 'tx',
    id: '__daily__',
    name: 'QQ 每日推荐',
    author: 'QQ 音乐',
    total: 30,
  }, {
    source: 'tx',
    id: '__guess__',
    name: 'QQ 猜你喜欢',
    author: 'QQ 音乐',
    total: 30,
  })

  const deduped = new Map<string, QQPlaylistInfo>()
  for (const playlist of result) {
    const key = playlist.id || playlist.name
    if (!deduped.has(key)) {
      rememberVirtualPlaylist(playlist)
      deduped.set(key, playlist)
    }
  }
  return [...deduped.values()]
}

async function listQQUserPlaylistsWindow(request: Request, limit: number): Promise<QQPlaylistInfo[]> {
  const playlists: QQPlaylistInfo[] = []
  let offset = 0
  const pageSize = Math.min(QQ_PLAYLIST_PAGE_SIZE, Math.max(limit, 1))

  for (;;) {
    const result = await getQQUserPlaylists({
      cookie: qqCookieForRequest(request),
      offset,
      limit: pageSize,
    })
    playlists.push(...result.list)
    if (result.list.length === 0 || playlists.length >= limit || offset + result.list.length >= result.total) break
    offset += pageSize
  }

  return playlists.slice(0, limit)
}

async function listQQFavoriteSongs(request: Request, limit: number): Promise<MusicInfo[]> {
  const cookie = qqCookieForRequest(request)
  const pageSize = Math.min(QQ_SONG_PAGE_SIZE, Math.max(limit, 1))
  const songs: MusicInfo[] = []
  let page = 1
  let allPage = 1

  do {
    const result = await getQQFavoriteSongs({ cookie, page, limit: pageSize }).catch(() => undefined)
    if (!result) break

    songs.push(...result.list)
    allPage = result.allPage ?? Math.ceil(result.total / result.limit)
    if (result.list.length === 0 || songs.length >= limit || songs.length >= result.total) break
    page += 1
  } while (page <= allPage)

  return dedupeSongs(songs).slice(0, limit)
}

async function searchQQMusicWindow(query: string, limit: number): Promise<MusicInfo[]> {
  const songs: MusicInfo[] = []
  const pageSize = Math.min(QQ_SONG_PAGE_SIZE, Math.max(limit, 1))
  let page = 1
  let allPage = 1

  do {
    const result = await searchQQMusic(query, page, pageSize).catch(() => undefined)
    if (!result) break
    songs.push(...result.list)
    allPage = result.allPage ?? Math.ceil(result.total / result.limit)
    if (result.list.length === 0 || songs.length >= limit || songs.length >= result.total) break
    page += 1
  } while (page <= allPage)

  return dedupeSongs(songs).slice(0, limit)
}

async function searchQQPlaylistsWindow(query: string, limit: number): Promise<QQPlaylistInfo[]> {
  const playlists: QQPlaylistInfo[] = []
  const pageSize = Math.min(QQ_PLAYLIST_PAGE_SIZE, Math.max(limit, 1))
  let page = 1
  let allPage = 1

  do {
    const result = await searchQQPlaylists(query, page, pageSize).catch(() => undefined)
    if (!result) break
    playlists.push(...result.list)
    allPage = result.allPage ?? Math.ceil(result.total / result.limit)
    if (result.list.length === 0 || playlists.length >= limit || playlists.length >= result.total) break
    page += 1
  } while (page <= allPage)

  return dedupePlaylists(playlists).slice(0, limit)
}

async function getQQPlaylistSongsWindow(id: string, limit: number): Promise<MusicInfo[]> {
  const detail = await getQQPlaylistDetail(id).catch(() => undefined)
  return dedupeSongs(detail?.list ?? []).slice(0, limit)
}

async function getQQRecommendationsWindow(request: Request, limit: number): Promise<MusicInfo[]> {
  const songs: MusicInfo[] = []
  let remaining = limit

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

  return dedupeSongs(songs).slice(0, limit)
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
    item.UserData.PlayCount = playCount
    item.UserData.LastPlayedDate = lastPlayedAt
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
      ServerId: 'mixmusic',
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
      ServerId: 'mixmusic',
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
  return {
    Name: playlist.name,
    ServerId: 'mixmusic',
    Id: id,
    Type: 'Playlist',
    MediaType: 'Audio',
    IsFolder: true,
    RecursiveItemCount: playlist.total ?? 0,
    Overview: playlist.desc,
    ImageTags: playlist.img ? { Primary: playlist.id } : {},
  }
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

function imageResponseHeaders(headers: Headers): Headers {
  const result = new Headers()
  const contentType = headers.get('content-type')
  const contentLength = headers.get('content-length')
  const cacheControl = headers.get('cache-control')
  if (contentType) result.set('content-type', contentType)
  if (contentLength) result.set('content-length', contentLength)
  if (cacheControl) result.set('cache-control', cacheControl)
  return result
}

function songToEmbyItem(song: MusicInfo, playlistId?: string, isFavorite = false) {
  return {
    Name: song.name,
    ServerId: 'mixmusic',
    Id: songVirtualId(song, playlistId),
    Type: 'Audio',
    MediaType: 'Audio',
    IsFolder: false,
    Album: song.albumName,
    AlbumId: song.albumId,
    Artists: song.singer.split(/[、,，/;；]+/).map(item => item.trim()).filter(Boolean),
    ArtistItems: song.singer.split(/[、,，/;；]+/).map((name, index) => ({ Name: name.trim(), Id: `${song.songmid}-artist-${index}` })).filter(item => item.Name),
    RunTimeTicks: intervalToTicks(song.interval),
    ImageTags: song.img ? { Primary: song.songmid } : {},
    UserData: {
      PlaybackPositionTicks: 0,
      PlayCount: 0,
      LastPlayedDate: undefined as string | undefined,
      IsFavorite: isFavorite,
    },
  }
}

function extractPlaylistId(path: string): string | undefined {
  const playlistMatch = path.match(/^\/Playlists\/([^/]+)\/Items$/i)
  if (playlistMatch?.[1]) return decodeURIComponent(playlistMatch[1])
  const userItemMatch = path.match(/^\/Users\/[^/]+\/Items\/([^/]+)\/Items$/i)
  return userItemMatch?.[1] ? decodeURIComponent(userItemMatch[1]) : undefined
}

function extractItemId(path: string): string | undefined {
  const itemMatch = path.match(/^\/Items\/([^/]+)$/i)
  if (itemMatch?.[1]) return decodeURIComponent(itemMatch[1])
  const userItemMatch = path.match(/^\/Users\/[^/]+\/Items\/([^/]+)$/i)
  return userItemMatch?.[1] ? decodeURIComponent(userItemMatch[1]) : undefined
}

function extractImageItemId(path: string): string | undefined {
  const itemMatch = path.match(/^\/Items\/([^/]+)\/Images\/[^/]+$/i)
  if (itemMatch?.[1]) return decodeURIComponent(itemMatch[1])
  const userMatch = path.match(/^\/Users\/([^/]+)\/Images\/[^/]+$/i)
  return userMatch?.[1] ? decodeURIComponent(userMatch[1]) : undefined
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

function startIndexParam(url: URL): number {
  const value = url.searchParams.get('StartIndex') ?? url.searchParams.get('startIndex')
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0
}

function pagedItemsResponse(items: any[], startIndex: number, limit: number): Response {
  return Response.json({
    Items: items.slice(startIndex, startIndex + limit),
    TotalRecordCount: items.length,
  })
}

async function tryReadItemsResponse(request: Request, embyPath: string): Promise<{ Items?: any[] } | undefined> {
  try {
    return await fetchEmbyJson<{ Items?: any[] }>(`${embyPath}${upstreamSearch(request)}`)
  } catch {
    return undefined
  }
}

function upstreamSearch(request: Request): string {
  const url = new URL(request.url)
  for (const key of ['ParentId', 'parentId']) {
    if (url.searchParams.get(key) === 'mixmusic-music') {
      url.searchParams.delete(key)
    }
  }
  return url.search
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
