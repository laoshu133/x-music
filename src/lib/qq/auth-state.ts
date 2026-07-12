import {
  getAccountByQQ,
  markAccountQQAuthExpired,
  type AccountRecord,
} from '@/lib/db/accounts'
import { logServiceEvent } from '@/lib/request-log'
import { parseQQAccessTokenExpiresAt } from './account'
import { QQMusicError } from './http'
import { refreshAccountQQAuthorizationIfNeeded } from './auth-refresh'

const expiredRecheckIntervalMs = Number(process.env.QQ_AUTH_EXPIRED_RECHECK_INTERVAL_MS ?? 6 * 60 * 60 * 1000)
const lastExpiredRecheckByUin = new Map<string, number>()

export class QQAuthExpiredError extends QQMusicError {
  constructor(message = 'QQ authorization has expired. Reauthorize QQ Music to continue.', payload?: unknown) {
    super(message, 401, {
      code: 'QQ_AUTH_EXPIRED',
      actionable: '重新完成 QQ 授权登录后再继续使用 XMusic。',
      ...(payload && typeof payload === 'object' ? payload as Record<string, unknown> : { detail: payload }),
    })
    this.name = 'QQAuthExpiredError'
  }
}

export async function requireActiveQQAccount<T extends AccountRecord | undefined>(
  account: T,
  options: { force?: boolean } = {},
): Promise<T> {
  if (!account) return account
  const recheckingExpiredAccount = account.qqAuthState === 'expired'
  if (account.qqAuthState === 'expired') {
    if (!shouldRecheckExpiredAccount(account, options)) {
      throw new QQAuthExpiredError(account.qqAuthError ?? undefined)
    }
    logServiceEvent('qq_auth_expired_recheck_attempt', {
      qqUin: account.qqUin,
      authError: account.qqAuthError,
      accessTokenExpiresAt: parseQQAccessTokenExpiresAt(account.qqCookie),
    })
    lastExpiredRecheckByUin.set(account.qqUin, Date.now())
  }

  try {
    const refreshed = await refreshAccountQQAuthorizationIfNeeded(account, {
      force: Boolean(options.force || recheckingExpiredAccount),
    })
    if (refreshed.error) return handleRefreshFailure(account, refreshed.error) as T
    if (refreshed.attempted) {
      logServiceEvent('qq_auth_refresh_applied', {
        qqUin: refreshed.account.qqUin,
        refreshed: refreshed.refreshed,
      })
    }
    if (recheckingExpiredAccount) lastExpiredRecheckByUin.delete(account.qqUin)
    return (getAccountByQQ(refreshed.account.qqUin) ?? refreshed.account) as T
  } catch (error) {
    return handleRefreshFailure(account, error) as T
  }
}

function handleRefreshFailure(account: AccountRecord, error: unknown): AccountRecord {
  const message = error instanceof Error ? error.message : String(error)
  if (isQQAuthExpiredError(error)) {
    markAccountQQAuthExpired(account.qqUin, message)
    logServiceEvent('qq_auth_marked_expired', {
      qqUin: account.qqUin,
      error: message,
      status: error instanceof QQMusicError ? error.status : undefined,
      payload: summarizeQQAuthErrorPayload(error),
    }, 'error')
    throw new QQAuthExpiredError(message)
  }

  logServiceEvent('qq_auth_refresh_degraded', {
    qqUin: account.qqUin,
    error: message,
    status: error instanceof QQMusicError ? error.status : undefined,
    payload: summarizeQQAuthErrorPayload(error),
  }, 'error')
  return getAccountByQQ(account.qqUin) ?? account
}

function shouldRecheckExpiredAccount(account: AccountRecord, options: { force?: boolean }): boolean {
  if (options.force) return true
  if (!account.qqmusicKey) return false
  const lastAttemptAt = lastExpiredRecheckByUin.get(account.qqUin)
  if (lastAttemptAt && Date.now() - lastAttemptAt < expiredRecheckIntervalMs) return false
  const accessTokenExpiresAt = parseQQAccessTokenExpiresAt(account.qqCookie)
  const expiresAtMs = accessTokenExpiresAt ? Date.parse(accessTokenExpiresAt) : NaN
  if (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()) return true

  const checkedAtMs = account.qqAuthCheckedAt ? Date.parse(account.qqAuthCheckedAt) : NaN
  return !Number.isFinite(checkedAtMs) || Date.now() - checkedAtMs >= expiredRecheckIntervalMs
}

export function isQQAuthExpiredError(error: unknown): boolean {
  if (error instanceof QQAuthExpiredError) return true
  if (error instanceof QQMusicError) {
    if (error.status === 401) return true
    if (isQQAuthExpiredMessage(error.message) || isQQAuthExpiredPayload(error.payload)) return true
  }
  if (!(error instanceof Error)) return false
  return isQQAuthExpiredMessage(error.message)
}

function isQQAuthExpiredMessage(value: string): boolean {
  const message = value.toLowerCase()
  return message.includes('login cookie')
    || message.includes('authorization')
    || message.includes('auth expired')
    || message.includes('not logged in')
    || message.includes('请登录')
    || message.includes('登录')
}

export function qqAuthExpiredResponse(error?: unknown): Response {
  if (error) {
    logServiceEvent('qq_auth_expired_response', {
      error: error instanceof Error ? error.message : String(error),
    }, 'error')
  }
  return Response.json({
    error: 'QQ 授权已失效，请重新登录。',
    code: 'QQ_AUTH_EXPIRED',
    actionable: '重新完成 QQ 授权登录后再继续使用 XMusic。',
  }, { status: 401 })
}

function isQQAuthExpiredPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const record = payload as Record<string, unknown>
  const code = record.code
  if (code === 401 || code === '401') return true
  if (typeof code === 'number' && code < 0) return true
  if (typeof code === 'string' && /^-\d+$/.test(code)) return true

  for (const key of ['message', 'msg', 'error', 'errMsg', 'desc', 'actionable']) {
    const value = record[key]
    if (typeof value === 'string' && isQQAuthExpiredMessage(value)) return true
  }

  return false
}

function summarizeQQAuthErrorPayload(error: unknown): unknown {
  if (!(error instanceof QQMusicError) || !error.payload || typeof error.payload !== 'object') return undefined
  const payload = error.payload as Record<string, unknown>
  return {
    code: payload.code,
    subcode: payload.subcode,
    message: firstString(payload.message, payload.msg, payload.error, payload.errMsg, payload.desc),
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim() !== '')
}
