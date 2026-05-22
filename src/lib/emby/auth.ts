import { getEffectiveSettings } from '@/lib/db/settings'
import { updateAccountEmbyAuth, type AccountRecord } from '@/lib/db/accounts'

const MUSIC_COLLECTION_TYPE = 'music'
const MUSIC_LIBRARY_NAME = '音乐'

interface EmbyLibraryCandidate {
  Id?: string
  ItemId?: string
  Name?: string
  CollectionType?: string
  Type?: string
  LibraryOptions?: {
    ItemId?: string
  }
  Locations?: string[]
}

export function embyAuthorizationHeader(token?: string): string {
  const parts = [
    'MediaBrowser Client="XMusic"',
    'Version="0.1.0"',
    'Device="XMusic"',
    'DeviceId="x-music-server"',
  ]
  if (token) parts.push(`Token="${token}"`)
  return parts.join(', ')
}

export async function getEmbyAccessToken(account?: AccountRecord): Promise<string | undefined> {
  const settings = getEffectiveSettings()
  if (account?.embyAccessToken) return account.embyAccessToken
  return settings.emby.apiKey
}

export async function ensureUpstreamEmbyUserForAccount(account: AccountRecord): Promise<AccountRecord> {
  const settings = getEffectiveSettings()
  if (!settings.emby.baseUrl || !settings.emby.apiKey) return account

  const existingById = account.embyUserId ? await findUpstreamUserById(account.embyUserId).catch(() => undefined) : undefined
  const existing = existingById ?? await findUpstreamUserByName(account.embyUsername)
  const userId = existing?.Id ?? await createUpstreamUser(account.embyUsername)
  if (userId && existing?.Name && existing.Name !== account.embyUsername) {
    await updateUpstreamUserName(userId, account.embyUsername).catch(() => undefined)
  }
  if (userId) await applyRestrictedUserPolicy(userId)
  updateAccountEmbyAuth({ qqUin: account.qqUin, embyUserId: userId })
  return {
    ...account,
    embyUserId: userId,
  }
}

async function applyRestrictedUserPolicy(userId: string): Promise<void> {
  const musicLibraryIds = await findMusicLibraryIds()
  if (!musicLibraryIds.length) {
    throw new Error('Unable to find upstream Emby music library id for restricted user policy')
  }
  await adminEmbyFetch(`/Users/${encodeURIComponent(userId)}/Policy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(restrictedUserPolicy(musicLibraryIds)),
  })
}

async function findMusicLibraryIds(): Promise<string[]> {
  const candidates = [
    ...await findMusicLibrariesFromVirtualFolders(),
    ...await findMusicLibrariesFromCollectionFolders(),
  ]
  const ids = candidates
    .filter(isMusicLibrary)
    .flatMap(readLibraryIds)
    .filter((id): id is string => Boolean(id))
  return [...new Set(ids)]
}

async function findMusicLibrariesFromVirtualFolders(): Promise<EmbyLibraryCandidate[]> {
  const views = await adminEmbyFetch<
    EmbyLibraryCandidate[]
    | { Items?: EmbyLibraryCandidate[] }
  >('/Library/VirtualFolders').catch(() => undefined)
  return Array.isArray(views) ? views : views?.Items ?? []
}

async function findMusicLibrariesFromCollectionFolders(): Promise<EmbyLibraryCandidate[]> {
  const data = await adminEmbyFetch<{ Items?: EmbyLibraryCandidate[] }>(`/Items?${new URLSearchParams({
    IncludeItemTypes: 'CollectionFolder',
    Recursive: 'false',
    Limit: '100',
  })}`).catch(() => undefined)
  return data?.Items ?? []
}

function isMusicLibrary(item: EmbyLibraryCandidate): boolean {
  const name = String(item.Name ?? '').trim()
  return item.CollectionType === MUSIC_COLLECTION_TYPE
    || name === MUSIC_LIBRARY_NAME
    || name.toLowerCase() === 'music'
}

function readLibraryIds(item: EmbyLibraryCandidate): string[] {
  return [
    item.ItemId,
    item.LibraryOptions?.ItemId,
    item.Id,
  ].filter((id): id is string => Boolean(id))
}

function restrictedUserPolicy(enabledFolders: string[]) {
  return {
    IsAdministrator: false,
    IsHidden: false,
    IsDisabled: false,
    EnableUserPreferenceAccess: true,
    EnableRemoteControlOfOtherUsers: false,
    EnableSharedDeviceControl: false,
    EnableRemoteAccess: true,
    EnableLiveTvManagement: false,
    EnableLiveTvAccess: false,
    EnableMediaPlayback: true,
    EnableAudioPlaybackTranscoding: true,
    EnableVideoPlaybackTranscoding: false,
    EnablePlaybackRemuxing: false,
    EnableContentDeletion: false,
    EnableContentDeletionFromFolders: [],
    EnableContentDownloading: false,
    EnableSyncTranscoding: false,
    EnableMediaConversion: false,
    EnableAllDevices: true,
    EnabledDevices: [],
    EnableAllChannels: false,
    EnabledChannels: [],
    EnableAllFolders: false,
    EnabledFolders: enabledFolders,
    InvalidLoginAttemptCount: 0,
    LoginAttemptsBeforeLockout: -1,
    MaxActiveSessions: 0,
    BlockedTags: [],
    EnablePublicSharing: false,
    RemoteClientBitrateLimit: 0,
    AuthenticationProviderId: 'Emby.Server.Implementations.Library.DefaultAuthenticationProvider',
    PasswordResetProviderId: 'Emby.Server.Implementations.Library.DefaultPasswordResetProvider',
    SyncPlayAccess: 'None',
  }
}

async function findUpstreamUserByName(username: string): Promise<{ Id?: string; Name?: string } | undefined> {
  const users = await adminEmbyFetch<Array<{ Id?: string; Name?: string }>>('/Users')
  return users.find(user => user.Name === username)
}

async function findUpstreamUserById(userId: string): Promise<{ Id?: string; Name?: string } | undefined> {
  return adminEmbyFetch<{ Id?: string; Name?: string }>(`/Users/${encodeURIComponent(userId)}`)
}

async function createUpstreamUser(username: string): Promise<string | undefined> {
  const created = await adminEmbyFetch<{ Id?: string; Name?: string }>('/Users/New', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Name: username }),
  })
  return created.Id
}

async function updateUpstreamUserName(userId: string, username: string): Promise<void> {
  await adminEmbyFetch(`/Users/${encodeURIComponent(userId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      Id: userId,
      Name: username,
    }),
  })
}

async function adminEmbyFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const settings = getEffectiveSettings()
  if (!settings.emby.baseUrl || !settings.emby.apiKey) {
    throw new Error('Upstream Emby base URL and API key are required')
  }

  const url = new URL(settings.emby.baseUrl)
  applyPathAndSearch(url, path)
  url.searchParams.set('api_key', settings.emby.apiKey)

  const headers = new Headers(init.headers)
  headers.set('X-Emby-Token', settings.emby.apiKey)
  headers.set('X-Emby-Authorization', embyAuthorizationHeader(settings.emby.apiKey))

  const response = await fetch(url, {
    ...init,
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(settings.emby.proxyTimeoutMs),
  })
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw new Error(`Emby admin request ${path} failed with ${response.status}: ${text.slice(0, 300)}`)
  }
  if (!text) return undefined as T
  return JSON.parse(text) as T
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
