import { ensureTrack, getPlayableTrackFile, insertPlayEvent, upsertTrackFileStatus } from '@/lib/cache/store'
import { createUpstreamTeeResponse, streamLocalFile } from '@/lib/cache/stream'
import { qualityFallbacks, resolveMusicUrlWithFallback } from '@/lib/music-url/resolve'
import {
  getQQPlaylistDetail,
  getQQRecommendations,
  getQQUserPlaylists,
  searchQQMusic,
} from '@/lib/qq'
import type { MusicInfo, MusicQuality, QQPlaylistInfo } from '@/lib/types'
import { enqueueEmbyTrackSync } from './sync'
import { markRequestSource } from '@/lib/request-log'
import { decodeVirtualId, encodeVirtualId, playlistVirtualId, songVirtualId } from './virtual-ids'
import { loadVirtualPlaylist, loadVirtualSong, rememberVirtualPlaylist, rememberVirtualSong } from './virtual-store'
import { getRemoteMapping, upsertRemoteMapping } from '@/lib/db/remote-mappings'
import { fetchEmbyJson, searchEmbyAudioByName, searchEmbyPlaylistByName } from './upstream-api'
import { proxyToUpstreamEmby } from './upstream-proxy'
import { getAccountByEmbyUsername, getAccountByEmbyUserId, listAccounts, type AccountRecord } from '@/lib/db/accounts'
import { ensureUpstreamEmbyUserForAccount } from './auth'
import crypto from 'node:crypto'

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

  if (request.method === 'GET' && isUserRequest(embyPath)) {
    if (!isAuthorizedLocalRequest(request)) return unauthorizedResponse()
    return handleUserRequest(embyPath)
  }

  if (request.method === 'GET' && embyPath === '/mixmusic/health') {
    return Response.json({ ok: true, service: 'mixmusic-emby-gateway' })
  }

  if (request.method === 'GET' && isItemsRequest(embyPath)) {
    if (!isAuthorizedLocalRequest(request)) return unauthorizedResponse()
    return handleItemsRequest(request, embyPath)
  }

  if (request.method === 'GET' && isPlaylistItemsRequest(embyPath)) {
    if (!isAuthorizedLocalRequest(request)) return unauthorizedResponse()
    return handlePlaylistItemsRequest(request, embyPath)
  }

  if (request.method === 'GET' && isAudioRequest(embyPath)) {
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
  const url = new URL(request.url)
  const token = request.headers.get('X-Emby-Token')
    ?? request.headers.get('X-MediaBrowser-Token')
    ?? url.searchParams.get('api_key')
    ?? url.searchParams.get('ApiKey')
  if (!token) return undefined
  return listAccounts().find(account => token === createLocalAccessToken(account))
}

function isAuthorizedLocalRequest(request: Request): boolean {
  return Boolean(authorizedLocalAccount(request))
}

function unauthorizedResponse(): Response {
  return Response.json({ error: 'Unauthorized' }, { status: 401 })
}

function createLocalAccessToken(account: AccountRecord): string {
  return crypto
    .createHash('sha256')
    .update(`${LOCAL_SERVER_ID}:${account.qqUin}:${account.embyUsername}:${account.embyPassword}`)
    .digest('hex')
}

function localUserId(account: AccountRecord): string {
  return account.embyUserId ?? crypto.createHash('sha1').update(`${LOCAL_SERVER_ID}:${account.qqUin}:${account.embyUsername}`).digest('hex')
}

function handlePublicUsers(): Response {
  return Response.json(listAccounts().map(localUser))
}

function handleUserRequest(path: string): Response | undefined {
  const requestedUserId = decodeURIComponent(path.split('/')[2] ?? '')
  const account = requestedUserId ? getAccountByEmbyUserId(requestedUserId) : undefined
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

function isItemsRequest(path: string): boolean {
  return /^\/Users\/[^/]+\/Items$/i.test(path) || path === '/Items'
}

function isPlaylistItemsRequest(path: string): boolean {
  return /^\/Playlists\/[^/]+\/Items$/i.test(path) || /^\/Users\/[^/]+\/Items\/[^/]+\/Items$/i.test(path)
}

function isAudioRequest(path: string): boolean {
  return /^\/Audio\/[^/]+\/(?:universal|stream)$/i.test(path)
}

async function handleItemsRequest(request: Request, embyPath: string): Promise<Response | undefined> {
  const url = new URL(request.url)
  const searchTerm = url.searchParams.get('SearchTerm') ?? url.searchParams.get('searchTerm') ?? url.searchParams.get('search')
  const includeTypes = url.searchParams.get('IncludeItemTypes') ?? url.searchParams.get('includeItemTypes') ?? ''

  if (searchTerm?.trim()) {
    const upstream = await tryReadItemsResponse(request, embyPath)
    const result = await searchQQMusic(searchTerm.trim(), 1, numberParam(url, 'Limit', 50))
    const upstreamItems = upstream?.Items ?? []
    const items = dedupeSongs(result.list)
      .filter(song => !hasEquivalentEmbySong(upstreamItems, song))
      .map(song => {
      rememberVirtualSong(song)
      return songToEmbyItem(song)
    })
    const merged = [...upstreamItems, ...items]
    return Response.json({ Items: merged, TotalRecordCount: merged.length })
  }

  if (includeTypes.split(',').map(item => item.trim().toLowerCase()).includes('playlist')) {
    const upstream = await tryReadItemsResponse(request, embyPath)
    const playlists = await listVirtualPlaylists(request)
    const upstreamItems = upstream?.Items ?? []
    const virtualItems = playlists
      .filter(playlist => !hasEquivalentEmbyPlaylist(upstreamItems, playlist.name))
      .map(playlistToEmbyItem)
    const merged = [...upstreamItems, ...virtualItems]
    return Response.json({ Items: merged, TotalRecordCount: merged.length })
  }

  return undefined
}

async function handlePlaylistItemsRequest(request: Request, embyPath: string): Promise<Response | undefined> {
  const playlistId = extractPlaylistId(embyPath)
  if (!playlistId) return undefined

  const decoded = decodeVirtualId(playlistId)
  if (!decoded) return undefined

  let songs: MusicInfo[] = []
  if (decoded.kind === 'qq-playlist') {
    const playlist = loadVirtualPlaylist(decoded.id)
    const mapped = getRemoteMapping({ localType: 'playlist', localKey: `qq:${decoded.id}`, remote: 'emby' })?.remoteId
      ?? (playlist ? await searchEmbyPlaylistByName(playlist.name).catch(() => undefined) : undefined)
    if (mapped) {
      upsertRemoteMapping({ localType: 'playlist', localKey: `qq:${decoded.id}`, remote: 'emby', remoteId: mapped, raw: playlist })
      return proxyToUpstreamEmby(request, `/Playlists/${encodeURIComponent(mapped)}/Items`)
    }
    const detail = await getQQPlaylistDetail(decoded.id)
    songs = detail.list
  } else if (decoded.kind === 'qq-guess') {
    songs = (await getQQRecommendations({ limit: numberParam(new URL(request.url), 'Limit', 50) })).list
  } else if (decoded.kind === 'qq-daily') {
    songs = (await getQQRecommendations({ limit: numberParam(new URL(request.url), 'Limit', 50) })).list
  } else {
    return undefined
  }

  const items = dedupeSongs(songs).map(song => {
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

function songToEmbyItem(song: MusicInfo, playlistId?: string) {
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
      IsFavorite: false,
    },
  }
}

function extractPlaylistId(path: string): string | undefined {
  const playlistMatch = path.match(/^\/Playlists\/([^/]+)\/Items$/i)
  if (playlistMatch?.[1]) return decodeURIComponent(playlistMatch[1])
  const userItemMatch = path.match(/^\/Users\/[^/]+\/Items\/([^/]+)\/Items$/i)
  return userItemMatch?.[1] ? decodeURIComponent(userItemMatch[1]) : undefined
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
    const url = new URL(request.url)
    return await fetchEmbyJson<{ Items?: any[] }>(`${embyPath}${url.search}`)
  } catch {
    return undefined
  }
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

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}
