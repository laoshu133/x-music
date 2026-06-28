import type { AccountRecord } from '@/lib/db/accounts'

export interface AccountEmbyUpstreamConfig {
  dsn?: string
  baseUrl?: string
  username?: string
  password?: string
  sourceWebdavDsn?: string
  proxyTimeoutMs: number
}

const defaultProxyTimeoutMs = 30000

export function embyConfigForAccount(account?: AccountRecord): AccountEmbyUpstreamConfig {
  const dsn = parseEmbyDsn(account?.embyDsn)
  return {
    dsn: normalizeUrl(account?.embyDsn),
    baseUrl: dsn?.baseUrl,
    username: dsn?.username,
    password: dsn?.password,
    sourceWebdavDsn: normalizeUrl(account?.embySourceWebdavDsn),
    proxyTimeoutMs: account?.embyProxyTimeoutMs && account.embyProxyTimeoutMs > 0
      ? account.embyProxyTimeoutMs
      : defaultProxyTimeoutMs,
  }
}

export function hasAccountUpstreamEmby(account?: AccountRecord): boolean {
  const config = embyConfigForAccount(account)
  return Boolean(config.baseUrl && config.username && config.password)
}

export function maskEmbyDsn(value?: string): string | undefined {
  const parsed = parseEmbyDsn(value)
  if (!parsed) return normalizeUrl(value)
  const url = new URL(parsed.baseUrl)
  if (parsed.username) url.username = encodeURIComponent(parsed.username)
  if (parsed.password) url.password = '********'
  return url.toString().replace(/\/+$/g, '')
}

function normalizeUrl(value?: string): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed.replace(/\/+$/g, '') : undefined
}

function parseEmbyDsn(value?: string): { baseUrl: string; username?: string; password?: string } | undefined {
  const normalized = normalizeUrl(value)
  if (!normalized) return undefined
  try {
    const url = new URL(normalized)
    const username = decodeURIComponent(url.username)
    const password = decodeURIComponent(url.password)
    url.username = ''
    url.password = ''
    return {
      baseUrl: url.toString().replace(/\/+$/g, ''),
      username: username || undefined,
      password: password || undefined,
    }
  } catch {
    return undefined
  }
}
