import { getEffectiveSettings } from '@/lib/db/settings'
import { updateAccountEmbyAuth, type AccountRecord } from '@/lib/db/accounts'
import { db } from '@/lib/db'

const MUSIC_COLLECTION_TYPE = 'music'
const MUSIC_LIBRARY_NAME = '音乐'
const UPSTREAM_MUSIC_LIBRARY_MAPPING_KEY = 'emby.upstreamMusicLibraryMapping'
const LEGACY_UPSTREAM_MUSIC_LIBRARY_IDS_KEY = 'emby.upstreamMusicLibraryIds'

interface EmbyLibraryCandidate {
  Id?: string
  ItemId?: string
  Guid?: string
  Name?: string
  CollectionType?: string
  Type?: string
  LibraryOptions?: {
    ItemId?: string
  }
  Locations?: string[]
}

interface UpstreamMusicLibraryMapping {
  parentIds: string[]
  policyIds: string[]
  locations: string[]
}

interface EmbyUserPolicy {
  EnableAllFolders?: boolean
  EnabledFolders?: string[]
}

interface EmbyUserWithPolicy {
  Id?: string
  Name?: string
  Policy?: EmbyUserPolicy
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
  const accessToken = userId ? await authenticateUpstreamUser(account.embyUsername).catch(() => undefined) : undefined
  updateAccountEmbyAuth({ qqUin: account.qqUin, embyUserId: userId, embyAccessToken: accessToken })
  return {
    ...account,
    embyUserId: userId,
    embyAccessToken: accessToken ?? account.embyAccessToken,
  }
}

async function applyRestrictedUserPolicy(userId: string): Promise<void> {
  const musicLibrary = await getUpstreamMusicLibraryMapping({ refresh: true })
  if (!musicLibrary.policyIds.length) {
    throw new Error('Unable to find upstream Emby music library id for restricted user policy')
  }
  await adminEmbyFetch(`/Users/${encodeURIComponent(userId)}/Policy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(restrictedUserPolicy(musicLibrary.policyIds)),
  })
  await verifyRestrictedUserPolicy(userId, musicLibrary.policyIds)
}

export async function getDefaultUpstreamMusicLibraryId(): Promise<string | undefined> {
  return readCachedMusicLibraryMapping().parentIds[0]
}

export async function getDefaultUpstreamMusicLibraryLocation(): Promise<string | undefined> {
  const cached = await getUpstreamMusicLibraryMapping()
  return cached.locations[0] ?? (await getUpstreamMusicLibraryMapping({ refresh: true })).locations[0]
}

async function getUpstreamMusicLibraryMapping(options: { refresh?: boolean } = {}): Promise<UpstreamMusicLibraryMapping> {
  if (!options.refresh) {
    const cached = readCachedMusicLibraryMapping()
    if (cached.policyIds.length || cached.parentIds.length) return cached
  }

  const mapping = await discoverMusicLibraryMapping()
  if (mapping.policyIds.length || mapping.parentIds.length) writeCachedMusicLibraryMapping(mapping)
  return mapping
}

async function discoverMusicLibraryMapping(): Promise<UpstreamMusicLibraryMapping> {
  const candidates = [
    ...await findMusicLibrariesFromVirtualFolders(),
    ...await findMusicLibrariesFromCollectionFolders(),
  ]
  const musicLibraries = candidates.filter(isMusicLibrary)
  return {
    parentIds: unique(musicLibraries.flatMap(readParentLibraryIds)),
    policyIds: unique(musicLibraries.flatMap(readPolicyLibraryIds)),
    locations: unique(musicLibraries.flatMap(readLibraryLocations)),
  }
}

function readCachedMusicLibraryMapping(): UpstreamMusicLibraryMapping {
  const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(UPSTREAM_MUSIC_LIBRARY_MAPPING_KEY) as { value_json: string } | undefined
  const fallback = readLegacyCachedMusicLibraryMapping()
  if (!row) return fallback
  try {
    const value = JSON.parse(row.value_json) as unknown
    if (!isObject(value)) return fallback
    return {
      parentIds: stringArray((value as { parentIds?: unknown }).parentIds),
      policyIds: stringArray((value as { policyIds?: unknown }).policyIds),
      locations: stringArray((value as { locations?: unknown }).locations),
    }
  } catch {
    return fallback
  }
}

function readLegacyCachedMusicLibraryMapping(): UpstreamMusicLibraryMapping {
  const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(LEGACY_UPSTREAM_MUSIC_LIBRARY_IDS_KEY) as { value_json: string } | undefined
  if (!row) return { parentIds: [], policyIds: [], locations: [] }
  try {
    const ids = stringArray(JSON.parse(row.value_json) as unknown)
    return { parentIds: ids, policyIds: ids, locations: [] }
  } catch {
    return { parentIds: [], policyIds: [], locations: [] }
  }
}

function writeCachedMusicLibraryMapping(mapping: UpstreamMusicLibraryMapping): void {
  db.prepare(`
    INSERT INTO app_settings (key, value_json, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
  `).run(UPSTREAM_MUSIC_LIBRARY_MAPPING_KEY, JSON.stringify(mapping))
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

function readParentLibraryIds(item: EmbyLibraryCandidate): string[] {
  return [
    item.ItemId,
    item.LibraryOptions?.ItemId,
    item.Id,
  ].filter((id): id is string => Boolean(id))
}

function readPolicyLibraryIds(item: EmbyLibraryCandidate): string[] {
  return [
    item.Guid,
    item.ItemId,
    item.LibraryOptions?.ItemId,
    item.Id,
  ].filter((id): id is string => Boolean(id))
}

function readLibraryLocations(item: EmbyLibraryCandidate): string[] {
  return item.Locations ?? []
}

function unique(ids: string[]): string[] {
  return [...new Set(ids.filter(id => Boolean(id.trim())))]
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? unique(value.filter((id): id is string => typeof id === 'string')) : []
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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
    EnableContentDeletion: true,
    EnableContentDeletionFromFolders: enabledFolders,
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

async function verifyRestrictedUserPolicy(userId: string, enabledFolders: string[]): Promise<void> {
  let lastPolicy: EmbyUserPolicy | undefined
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const user = await adminEmbyFetch<EmbyUserWithPolicy>(`/Users/${encodeURIComponent(userId)}`)
    lastPolicy = user.Policy
    if (isExpectedRestrictedPolicy(lastPolicy, enabledFolders)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Upstream Emby user policy verification failed for ${userId}: expected music folders ${enabledFolders.join(', ')}, got ${lastPolicy?.EnabledFolders?.join(', ') ?? '(none)'}`)
}

function isExpectedRestrictedPolicy(policy: EmbyUserPolicy | undefined, enabledFolders: string[]): boolean {
  const actualFolders = new Set(policy?.EnabledFolders ?? [])
  return policy?.EnableAllFolders === false && enabledFolders.some(id => actualFolders.has(id))
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

async function authenticateUpstreamUser(username: string): Promise<string | undefined> {
  const result = await adminEmbyFetch<{ AccessToken?: string }>('/Users/AuthenticateByName', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Username: username, Pw: '' }),
  })
  return result.AccessToken
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
