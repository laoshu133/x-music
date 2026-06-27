import type { AccountRecord } from '@/lib/db/accounts'
import type { MusicInfo } from '@/lib/types'
import { embyAuthorizationHeader, getEmbyAccessToken } from './auth'
import { embyConfigForAccount } from './config'

export type EmbyAudioUserDataItem = {
  Id?: string
  Name?: string
  Album?: string
  Artists?: string[]
  UserData?: {
    IsFavorite?: boolean
    Played?: boolean
    PlayCount?: number
    LastPlayedDate?: string
    FavoriteDate?: string
    DateFavorite?: string
    DateLastFavorite?: string
  }
  ProviderIds?: Record<string, string>
  Path?: string
  MediaSources?: Array<{ Path?: string }>
}

export async function refreshEmbyLibrary(account?: AccountRecord): Promise<unknown> {
  return embyFetch('/Library/Refresh', { method: 'POST' }, { account })
}

export async function fetchEmbyJson<T = unknown>(path: string, init: RequestInit = {}, options: EmbyFetchOptions = {}): Promise<T> {
  return embyFetch<T>(path, init, options)
}

export async function fetchEmbyText(path: string, init: RequestInit = {}, options: EmbyFetchOptions = {}): Promise<string> {
  return embyFetchText(path, init, options)
}

export async function notifyEmbyMediaUpdated(path?: string, options: EmbyFetchOptions = {}): Promise<unknown> {
  return embyFetch('/Library/Media/Updated', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(path ? { Updates: [{ Path: path, UpdateType: 'Created' }] } : {}),
  }, options).catch(() => refreshEmbyLibrary(options.account))
}

export async function searchEmbyAudioByName(song: MusicInfo, options: EmbyFetchOptions = {}): Promise<string | undefined> {
  const data = await embyFetch<{
    Items?: Array<{ Id?: string; Name?: string; Artists?: string[]; Album?: string }>
  }>(`/Items?${new URLSearchParams({
    IncludeItemTypes: 'Audio',
    Recursive: 'true',
    SearchTerm: song.name,
    Limit: '10',
  })}`, {}, options)

  const normalizedArtist = normalize(song.singer)
  const match = data.Items?.find(item => {
    const artist = normalize(item.Artists?.join(' ') ?? '')
    return normalize(item.Name) === normalize(song.name) && (!normalizedArtist || artist.includes(normalizedArtist) || normalizedArtist.includes(artist))
  })

  return match?.Id
}

export async function searchEmbyAudioByPath(path: string, options: EmbyFetchOptions = {}): Promise<string | undefined> {
  const data = await embyFetch<{
    Items?: Array<{ Id?: string; Path?: string; MediaSources?: Array<{ Path?: string }> }>
  }>(`/Items?${new URLSearchParams({
    IncludeItemTypes: 'Audio',
    Recursive: 'true',
    Fields: 'Path,MediaSources',
    Path: path,
    Limit: '10',
  })}`, {}, options)

  const normalizedPath = normalizePath(path)
  const match = data.Items?.find(item => {
    const paths = [
      item.Path,
      ...(item.MediaSources ?? []).map(source => source.Path),
    ]
    return paths.some(candidate => normalizePath(candidate) === normalizedPath)
  })

  return match?.Id
}

export async function fetchEmbyAudioMediaInfo(itemId: string, options: { userId?: string } = {}): Promise<{
  id?: string
  name?: string
  path?: string
  container?: string
  size?: number
  mediaSources?: Array<{
    path?: string
    container?: string
    size?: number
    mediaStreams?: Array<{
      codec?: string
      type?: string
      bitRate?: number
    }>
  }>
} | undefined> {
  const data = await embyFetch<{
    Id?: string
    Name?: string
    Path?: string
    Container?: string
    Size?: number
    MediaSources?: Array<{
      Path?: string
      Container?: string
      Size?: number
      MediaStreams?: Array<{
        Codec?: string
        Type?: string
        BitRate?: number
      }>
    }>
  }>(`${embyItemInfoPath(itemId, options.userId)}?${new URLSearchParams({
    Fields: 'Path,MediaSources,MediaStreams,Size',
  })}`).catch(() => undefined)

  if (!data) return undefined
  return {
    id: data.Id,
    name: data.Name,
    path: data.Path,
    container: data.Container,
    size: data.Size,
    mediaSources: data.MediaSources?.map(source => ({
      path: source.Path,
      container: source.Container,
      size: source.Size,
      mediaStreams: source.MediaStreams?.map(stream => ({
        codec: stream.Codec,
        type: stream.Type,
        bitRate: stream.BitRate,
      })),
    })),
  }
}

function embyItemInfoPath(itemId: string, userId?: string): string {
  const encodedItemId = encodeURIComponent(itemId)
  return userId
    ? `/Users/${encodeURIComponent(userId)}/Items/${encodedItemId}`
    : `/Items/${encodedItemId}`
}

export async function searchEmbyPlaylistByName(name: string, options: EmbyFetchOptions = {}): Promise<string | undefined> {
  const data = await embyFetch<{
    Items?: Array<{ Id?: string; Name?: string }>
  }>(`/Items?${new URLSearchParams({
    IncludeItemTypes: 'Playlist',
    Recursive: 'true',
    SearchTerm: name,
    Limit: '10',
  })}`, {}, options)
  return data.Items?.find(item => normalize(item.Name) === normalize(name))?.Id
}

export async function createOrUpdateEmbyPlaylist(input: {
  name: string
  itemIds: string[]
}, options: EmbyFetchOptions = {}): Promise<unknown> {
  if (!input.itemIds.length) return undefined
  const existing = await embyFetch<{ Items?: Array<{ Id?: string; Name?: string }> }>(`/Items?${new URLSearchParams({
    IncludeItemTypes: 'Playlist',
    Recursive: 'true',
    SearchTerm: input.name,
    Limit: '10',
  })}`, {}, options).catch(() => undefined)
  const playlist = existing?.Items?.find(item => item.Name === input.name)
  if (playlist?.Id) {
    return embyFetch(`/Playlists/${encodeURIComponent(playlist.Id)}/Items?${new URLSearchParams({ Ids: input.itemIds.join(',') })}`, {
      method: 'POST',
    }, options)
  }

  return embyFetch(`/Playlists?${new URLSearchParams({
    Name: input.name,
    Ids: input.itemIds.join(','),
    MediaType: 'Audio',
  })}`, { method: 'POST' }, options)
}

export async function deleteEmbyItems(ids: string[], options: EmbyFetchOptions = {}): Promise<void> {
  if (!ids.length) return
  await embyFetch(`/Items/Delete?${new URLSearchParams({ Ids: ids.join(',') })}`, { method: 'POST' }, options)
}

export async function setEmbyFavorite(input: {
  userId: string
  itemId: string
  favorite: boolean
}, options: EmbyFetchOptions = {}): Promise<unknown> {
  return embyFetch(`/Users/${encodeURIComponent(input.userId)}/FavoriteItems/${encodeURIComponent(input.itemId)}`, {
    method: input.favorite ? 'POST' : 'DELETE',
  }, options)
}

export async function fetchEmbyFavoriteAudioItems(input: {
  userId: string
  limit?: number
  startIndex?: number
}, options: EmbyFetchOptions = {}): Promise<{ Items?: EmbyAudioUserDataItem[]; TotalRecordCount?: number }> {
  return embyFetch(`/Users/${encodeURIComponent(input.userId)}/Items?${new URLSearchParams({
    IncludeItemTypes: 'Audio',
    Recursive: 'true',
    Filters: 'IsFavorite',
    SortBy: 'DateCreated,SortName',
    SortOrder: 'Descending,Ascending',
    Fields: 'ProviderIds,Path,MediaSources,UserData',
    EnableUserData: 'true',
    Limit: String(input.limit ?? 500),
    StartIndex: String(input.startIndex ?? 0),
  })}`, {}, options)
}

export async function fetchEmbyPlayedAudioItems(input: {
  userId: string
  limit?: number
  startIndex?: number
  sortBy?: 'DatePlayed' | 'PlayCount,DatePlayed'
}, options: EmbyFetchOptions = {}): Promise<{ Items?: EmbyAudioUserDataItem[]; TotalRecordCount?: number }> {
  return embyFetch(`/Users/${encodeURIComponent(input.userId)}/Items?${new URLSearchParams({
    IncludeItemTypes: 'Audio',
    Recursive: 'true',
    Filters: 'IsPlayed',
    SortBy: input.sortBy ?? 'DatePlayed',
    SortOrder: 'Descending',
    Fields: 'ProviderIds,Path,MediaSources,UserData',
    EnableUserData: 'true',
    Limit: String(input.limit ?? 200),
    StartIndex: String(input.startIndex ?? 0),
  })}`, {}, options)
}

export async function markEmbyPlayed(input: {
  userId: string
  itemId: string
  datePlayed?: string
}, options: EmbyFetchOptions = {}): Promise<unknown> {
  const search = new URLSearchParams()
  if (input.datePlayed) search.set('DatePlayed', input.datePlayed)
  const suffix = search.toString() ? `?${search.toString()}` : ''
  return embyFetch(`/Users/${encodeURIComponent(input.userId)}/PlayedItems/${encodeURIComponent(input.itemId)}${suffix}`, {
    method: 'POST',
  }, options)
}

interface EmbyFetchOptions {
  account?: AccountRecord
  token?: string
}

async function embyFetch<T = unknown>(path: string, init: RequestInit = {}, options: EmbyFetchOptions = {}): Promise<T> {
  const text = await embyFetchText(path, init, options)
  if (!text) return undefined as T
  return JSON.parse(text) as T
}

async function embyFetchText(path: string, init: RequestInit = {}, options: EmbyFetchOptions = {}): Promise<string> {
  const settings = embyConfigForAccount(options.account)
  if (!settings.baseUrl) throw new Error('Upstream Emby is not configured')
  let token = options.token ?? await getEmbyAccessToken(options.account)
  const url = new URL(settings.baseUrl)
  applyPathAndSearch(url, path)
  if (token && !url.searchParams.has('api_key')) url.searchParams.set('api_key', token)

  const headers = new Headers(init.headers)
  if (token && !headers.has('X-Emby-Token')) headers.set('X-Emby-Token', token)
  if (token && !headers.has('X-Emby-Authorization')) headers.set('X-Emby-Authorization', embyAuthorizationHeader(token))

  const response = await fetch(url, {
    ...init,
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(settings.proxyTimeoutMs),
  })
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw new Error(`Emby request ${path} failed with ${response.status}: ${text.slice(0, 300)}`)
  }
  return text
}

function applyPathAndSearch(url: URL, path: string): void {
  const [pathname, search = ''] = path.split('?')
  url.pathname = joinPaths(url.pathname, pathname ?? '/')
  url.search = search ? `?${search}` : ''
}

function joinPaths(basePath: string, childPath: string): string {
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
  const child = childPath.startsWith('/') ? childPath : `/${childPath}`
  return `${base}${child}` || '/'
}

function normalize(value?: string): string {
  return (value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function normalizePath(value?: string): string {
  return (value ?? '').trim().toLowerCase().replace(/\\/g, '/').replace(/\/+/g, '/')
}
