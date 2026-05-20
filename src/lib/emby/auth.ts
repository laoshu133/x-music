import { deleteSetting, getEffectiveSettings, setSetting } from '@/lib/db/settings'

interface EmbyAuthResponse {
  AccessToken?: string
  ServerId?: string
  User?: {
    Id?: string
  }
}

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

export async function getEmbyAccessToken(): Promise<string | undefined> {
  const settings = getEffectiveSettings()
  if (settings.emby.apiKey) return settings.emby.apiKey
  if (settings.emby.accessToken) return settings.emby.accessToken
  if (!settings.emby.baseUrl || !settings.emby.username || !settings.emby.password) return undefined

  const auth = await loginToEmby(settings.emby.baseUrl, settings.emby.username, settings.emby.password, settings.emby.proxyTimeoutMs)
  if (!auth.AccessToken) throw new Error('Emby authentication did not return AccessToken')
  setSetting('emby.accessToken', auth.AccessToken)
  if (auth.User?.Id) setSetting('emby.userId', auth.User.Id)
  if (auth.ServerId) setSetting('emby.serverId', auth.ServerId)
  return auth.AccessToken
}

export async function refreshEmbyAccessToken(): Promise<string | undefined> {
  deleteSetting('emby.accessToken')
  deleteSetting('emby.userId')
  deleteSetting('emby.serverId')
  return getEmbyAccessToken()
}

async function loginToEmby(baseUrl: string, username: string, password: string, timeoutMs: number): Promise<EmbyAuthResponse> {
  const attempts = [
    '/Users/AuthenticateByName',
    '/emby/Users/AuthenticateByName',
  ]
  let lastError: unknown

  for (const path of attempts) {
    try {
      const url = new URL(baseUrl)
      url.pathname = joinPaths(url.pathname, path)
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Emby-Authorization': embyAuthorizationHeader(),
        },
        body: JSON.stringify({ Username: username, Pw: password }),
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text().catch(() => '')
      if (!response.ok) {
        lastError = new Error(`Emby login ${path} failed with ${response.status}: ${text.slice(0, 300)}`)
        continue
      }
      return JSON.parse(text) as EmbyAuthResponse
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function joinPaths(basePath: string, childPath: string): string {
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
  const child = childPath.startsWith('/') ? childPath : `/${childPath}`
  return `${base}${child}` || '/'
}
