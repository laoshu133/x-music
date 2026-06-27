import type { AccountRecord } from '@/lib/db/accounts'

export interface AccountEmbyUpstreamConfig {
  baseUrl?: string
  apiKey?: string
  sourceWebdavDsn?: string
  proxyTimeoutMs: number
}

const defaultProxyTimeoutMs = 30000

export function embyConfigForAccount(account?: AccountRecord): AccountEmbyUpstreamConfig {
  return {
    baseUrl: normalizeUrl(account?.embyBaseUrl),
    apiKey: account?.embyApiKey?.trim() || undefined,
    sourceWebdavDsn: normalizeUrl(account?.embySourceWebdavDsn),
    proxyTimeoutMs: account?.embyProxyTimeoutMs && account.embyProxyTimeoutMs > 0
      ? account.embyProxyTimeoutMs
      : defaultProxyTimeoutMs,
  }
}

export function hasAccountUpstreamEmby(account?: AccountRecord): boolean {
  const config = embyConfigForAccount(account)
  return Boolean(config.baseUrl && config.apiKey)
}

function normalizeUrl(value?: string): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed.replace(/\/+$/g, '') : undefined
}
