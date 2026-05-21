import { ensureTrack, getPlayableTrackFile, insertPlayEvent, upsertTrackFileStatus } from '@/lib/cache/store'
import { createUpstreamTeeResponse, streamLocalFile } from '@/lib/cache/stream'
import { qualityFallbacks, resolveMusicUrlWithFallback } from '@/lib/music-url/resolve'
import {
  getQQPlaylistDetail,
  getQQFavoriteSongs,
  getQQRecommendations,
  getQQUserPlaylists,
  searchQQMusic,
  searchQQPlaylists,
} from '@/lib/qq'
import type { MusicInfo, MusicQuality, QQPlaylistInfo } from '@/lib/types'
import { enqueueEmbyTrackSync } from './sync'
import { markRequestSource } from '@/lib/request-log'
import { albumVirtualId, decodeVirtualId, encodeVirtualId, playlistVirtualId, songVirtualId, type VirtualId } from './virtual-ids'
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

  if (searchTerm?.trim()) {
    const upstream = await tryReadItemsResponse(request, embyPath)
    const upstreamItems = filterItemsByTypes(upstream?.Items ?? [], requestedTypes)
    const virtualItems: any[] = []

    if (shouldIncludeType(requestedTypes, 'audio')) {
      const result = await searchQQMusic(searchTerm.trim(), 1, numberParam(url, 'Limit', 50))
      virtualItems.push(...dedupeSongs(result.list)
        .filter(song => !hasEquivalentEmbySong(upstreamItems, song))
        .map(song => {
          rememberVirtualSong(song)
          return songToEmbyItem(song)
        }))
    }

    if (shouldIncludeType(requestedTypes, 'playlist')) {
      const result = await searchQQPlaylists(searchTerm.trim(), 1, numberParam(url, 'Limit', 50))
      virtualItems.push(...result.list
        .filter(playlist => !hasEquivalentEmbyPlaylist(upstreamItems, playlist.name))
        .map(playlistToEmbyItem))
    }

    const merged = [...upstreamItems, ...virtualItems]
    return Response.json({ Items: merged, TotalRecordCount: merged.length })
  }

  if (filters.has('isfavorite') && shouldIncludeType(requestedTypes, 'audio')) {
    const upstream = await tryReadItemsResponse(request, embyPath)
    const upstreamItems = filterItemsByTypes(upstream?.Items ?? [], requestedTypes)
    const favorites = await listQQFavoriteSongs(request, numberParam(url, 'Limit', 500))
    const virtualItems = favorites
      .filter(song => !hasEquivalentEmbySong(upstreamItems, song))
      .map(song => {
        rememberVirtualSong(song)
        return songToEmbyItem(song, undefined, true)
      })
    const merged = [...upstreamItems, ...virtualItems]
    return Response.json({ Items: merged, TotalRecordCount: merged.length })
  }

  if (parentId === 'mixmusic-music' && requestedTypes.has('musicalbum')) {
    const upstream = await tryReadItemsResponse(request, embyPath)
    const upstreamItems = filterItemsByTypes(upstream?.Items ?? [], requestedTypes)
    const favorites = await listQQFavoriteSongs(request, numberParam(url, 'Limit', 500))
    const virtualAlbums = favoriteSongsToAlbumItems(favorites)
      .filter(album => !hasEquivalentEmbyAlbum(upstreamItems, album.Name))
    const merged = [...upstreamItems, ...virtualAlbums]
    return Response.json({ Items: merged, TotalRecordCount: merged.length })
  }

  if (requestedTypes.has('playlist')) {
    const upstream = await tryReadItemsResponse(request, embyPath)
    const playlists = await listVirtualPlaylists(request)
    const upstreamItems = upstream?.Items ?? []
    const virtualItems = playlists
      .filter(playlist => !hasEquivalentEmbyPlaylist(upstreamItems, playlist.name))
      .map(playlistToEmbyItem)
    const merged = [...upstreamItems, ...virtualItems]
    return Response.json({ Items: merged, TotalRecordCount: merged.length })
  }

  if (parentId === 'mixmusic-music') {
    const upstream = await tryReadItemsResponse(request, embyPath)
    return upstream ? Response.json(upstream) : emptyItemsResponse()
  }

  return undefined
}

async function handleCollectionRequest(request: Request, embyPath: string): Promise<Response> {
  const upstream = await tryReadItemsResponse(request, embyPath)
  return upstream ? Response.json(upstream) : emptyItemsResponse()
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

  let songs: MusicInfo[] = []
  if (decoded.kind === 'qq-playlist') {
    const detail = await getQQPlaylistDetail(decoded.id).catch(() => undefined)
    songs = detail?.list ?? []
  } else if (decoded.kind === 'qq-album') {
    songs = loadVirtualAlbumSongs(decoded.id)
  } else if (decoded.kind === 'qq-guess') {
    songs = (await getQQRecommendations({ limit: numberParam(url, 'Limit', 50) }).catch(() => ({ list: [] }))).list
  } else if (decoded.kind === 'qq-daily') {
    songs = (await getQQRecommendations({ limit: numberParam(url, 'Limit', 50) }).catch(() => ({ list: [] }))).list
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
  return Response.json({ Items: items, TotalRecordCount: items.length })
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

async function listVirtualPlaylists(request: Request): Promise<QQPlaylistInfo[]> {
  const result: QQPlaylistInfo[] = []

  try {
    const userPlaylists = await getQQUserPlaylists({
      cookie: request.headers.get('x-qq-music-cookie') ?? undefined,
      limit: 100,
    })
    result.push(...userPlaylists.list)
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

async function listQQFavoriteSongs(request: Request, limit: number): Promise<MusicInfo[]> {
  const cookie = authorizedLocalAccount(request)?.qqCookie
    ?? request.headers.get('x-qq-music-cookie')
    ?? undefined
  const result = await getQQFavoriteSongs({ cookie, limit }).catch(() => undefined)
  return dedupeSongs(result?.list ?? [])
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
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.trunc(parsed), 200) : fallback
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

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function parseFilters(filters: string): Set<string> {
  return new Set(filters.split(',').map(item => item.trim().toLowerCase()).filter(Boolean))
}
