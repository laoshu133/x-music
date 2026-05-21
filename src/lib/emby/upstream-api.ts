import { getEffectiveSettings } from '@/lib/db/settings'
import type { MusicInfo } from '@/lib/types'
import { embyAuthorizationHeader, getEmbyAccessToken } from './auth'

export async function refreshEmbyLibrary(): Promise<unknown> {
  return embyFetch('/Library/Refresh', { method: 'POST' })
}

export async function fetchEmbyJson<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  return embyFetch<T>(path, init)
}

export async function notifyEmbyMediaUpdated(path?: string): Promise<unknown> {
  return embyFetch('/Library/Media/Updated', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(path ? { Updates: [{ Path: path, UpdateType: 'Created' }] } : {}),
  }).catch(() => refreshEmbyLibrary())
}

export async function searchEmbyAudioByName(song: MusicInfo): Promise<string | undefined> {
  const data = await embyFetch<{
    Items?: Array<{ Id?: string; Name?: string; Artists?: string[]; Album?: string }>
  }>(`/Items?${new URLSearchParams({
    IncludeItemTypes: 'Audio',
    Recursive: 'true',
    SearchTerm: song.name,
    Limit: '10',
  })}`)

  const normalizedArtist = normalize(song.singer)
  const match = data.Items?.find(item => {
    const artist = normalize(item.Artists?.join(' ') ?? '')
    return normalize(item.Name) === normalize(song.name) && (!normalizedArtist || artist.includes(normalizedArtist) || normalizedArtist.includes(artist))
  }) ?? data.Items?.[0]

  return match?.Id
}

export async function searchEmbyPlaylistByName(name: string): Promise<string | undefined> {
  const data = await embyFetch<{
    Items?: Array<{ Id?: string; Name?: string }>
  }>(`/Items?${new URLSearchParams({
    IncludeItemTypes: 'Playlist',
    Recursive: 'true',
    SearchTerm: name,
    Limit: '10',
  })}`)
  return data.Items?.find(item => normalize(item.Name) === normalize(name))?.Id
    ?? data.Items?.[0]?.Id
}

export async function createOrUpdateEmbyPlaylist(input: {
  name: string
  itemIds: string[]
}): Promise<unknown> {
  if (!input.itemIds.length) return undefined
  const existing = await embyFetch<{ Items?: Array<{ Id?: string; Name?: string }> }>(`/Items?${new URLSearchParams({
    IncludeItemTypes: 'Playlist',
    Recursive: 'true',
    SearchTerm: input.name,
    Limit: '10',
  })}`).catch(() => undefined)
  const playlist = existing?.Items?.find(item => item.Name === input.name)
  if (playlist?.Id) {
    return embyFetch(`/Playlists/${encodeURIComponent(playlist.Id)}/Items?${new URLSearchParams({ Ids: input.itemIds.join(',') })}`, {
      method: 'POST',
    })
  }

  return embyFetch(`/Playlists?${new URLSearchParams({
    Name: input.name,
    Ids: input.itemIds.join(','),
    MediaType: 'Audio',
  })}`, { method: 'POST' })
}

async function embyFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const settings = getEffectiveSettings()
  if (!settings.emby.baseUrl) throw new Error('Upstream Emby is not configured')
  let token = await getEmbyAccessToken()
  const url = new URL(settings.emby.baseUrl)
  url.pathname = joinPaths(url.pathname, path)
  if (token && !url.searchParams.has('api_key')) url.searchParams.set('api_key', token)

  const headers = new Headers(init.headers)
  if (token && !headers.has('X-Emby-Token')) headers.set('X-Emby-Token', token)
  if (token && !headers.has('X-Emby-Authorization')) headers.set('X-Emby-Authorization', embyAuthorizationHeader(token))

  const response = await fetch(url, {
    ...init,
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(settings.emby.proxyTimeoutMs),
  })
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw new Error(`Emby request ${path} failed with ${response.status}: ${text.slice(0, 300)}`)
  }
  if (!text) return undefined as T
  return JSON.parse(text) as T
}

function joinPaths(basePath: string, childPath: string): string {
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
  const child = childPath.startsWith('/') ? childPath : `/${childPath}`
  return `${base}${child}` || '/'
}

function normalize(value?: string): string {
  return (value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}
