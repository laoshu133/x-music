import {
  getAccountByQQ,
  updateAccountQQCookie,
  type AccountRecord,
} from '@/lib/db/accounts'
import { getStoredQQLoginState, updateStoredQQLoginCookie } from '@/lib/db/qq-session'
import { parseQQAccessTokenExpiresAt } from './account'
import { refreshQQMusickey } from './session-refresh'

const defaultRefreshWindowMs = Number(process.env.QQ_AUTH_AUTO_REFRESH_WINDOW_MS ?? 7 * 24 * 60 * 60 * 1000)
const defaultRefreshMinIntervalMs = Number(process.env.QQ_AUTH_AUTO_REFRESH_MIN_INTERVAL_MS ?? 6 * 60 * 60 * 1000)
const lastRefreshAttemptByUin = new Map<string, number>()

export interface QQAuthorizationRefreshResult {
  account: AccountRecord
  attempted: boolean
  refreshed: boolean
  error?: unknown
}

export async function refreshAccountQQAuthorizationIfNeeded(
  account: AccountRecord,
  options: {
    force?: boolean
    refreshWindowMs?: number
    minIntervalMs?: number
  } = {},
): Promise<QQAuthorizationRefreshResult> {
  if (!shouldRefreshAccountQQAuthorization(account, options)) {
    return { account, attempted: false, refreshed: false }
  }

  lastRefreshAttemptByUin.set(account.qqUin, Date.now())
  try {
    const result = await refreshQQMusickey({ cookie: account.qqCookie })
    updateStoredSessionIfCurrentAccount(result.uin, result.cookie)
    const refreshedAccount = updateAccountQQCookie(result.cookie) ?? getAccountByQQ(result.uin) ?? account
    return {
      account: refreshedAccount,
      attempted: true,
      refreshed: result.changed,
    }
  } catch (error) {
    if (options.force) throw error
    return {
      account,
      attempted: true,
      refreshed: false,
      error,
    }
  }
}

export function shouldRefreshAccountQQAuthorization(
  account: AccountRecord,
  options: {
    force?: boolean
    refreshWindowMs?: number
    minIntervalMs?: number
  } = {},
): boolean {
  if (options.force) return true
  if (account.qqAuthState === 'expired') return false

  const expiresAt = parseQQAccessTokenExpiresAt(account.qqCookie)
  if (!expiresAt) return false

  const expiresAtMs = Date.parse(expiresAt)
  if (!Number.isFinite(expiresAtMs)) return false

  const now = Date.now()
  const refreshWindowMs = options.refreshWindowMs ?? defaultRefreshWindowMs
  if (expiresAtMs - now > refreshWindowMs) return false

  const minIntervalMs = options.minIntervalMs ?? defaultRefreshMinIntervalMs
  const lastAttemptAt = lastRefreshAttemptByUin.get(account.qqUin)
  return !lastAttemptAt || now - lastAttemptAt >= minIntervalMs
}

function updateStoredSessionIfCurrentAccount(uin: string, cookie: string): void {
  const stored = getStoredQQLoginState()
  if (stored?.uin === uin) updateStoredQQLoginCookie(cookie)
}
