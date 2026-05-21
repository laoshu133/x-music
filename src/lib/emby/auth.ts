import { getEffectiveSettings } from '@/lib/db/settings'
import { updateAccountEmbyAuth, type AccountRecord } from '@/lib/db/accounts'

export function embyAuthorizationHeader(token?: string): string {
  const parts = [
    'MediaBrowser Client="miXmusic"',
    'Version="0.1.0"',
    'Device="miXmusic"',
    'DeviceId="mixmusic-server"',
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

  const existing = await findUpstreamUserByName(account.embyUsername)
  const userId = existing?.Id ?? await createUpstreamUser(account.embyUsername)
  updateAccountEmbyAuth({ qqUin: account.qqUin, embyUserId: userId })
  return {
    ...account,
    embyUserId: userId,
  }
}

async function findUpstreamUserByName(username: string): Promise<{ Id?: string; Name?: string } | undefined> {
  const users = await adminEmbyFetch<Array<{ Id?: string; Name?: string }>>('/Users')
  return users.find(user => user.Name === username)
}

async function createUpstreamUser(username: string): Promise<string | undefined> {
  const created = await adminEmbyFetch<{ Id?: string; Name?: string }>('/Users/New', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Name: username }),
  })
  return created.Id
}

async function adminEmbyFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const settings = getEffectiveSettings()
  if (!settings.emby.baseUrl || !settings.emby.apiKey) {
    throw new Error('Upstream Emby base URL and API key are required')
  }

  const url = new URL(settings.emby.baseUrl)
  url.pathname = joinPaths(url.pathname, path)
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

function joinPaths(basePath: string, childPath: string): string {
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
  const child = childPath.startsWith('/') ? childPath : `/${childPath}`
  return `${base}${child}` || '/'
}
