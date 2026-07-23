import {
  getAccountByUserId,
  markAccountQQAuthExpired,
  type AccountRecord,
} from '@/lib/db/accounts'
import { logServiceEvent } from '@/lib/request-log'
import { parseQQAccessTokenExpiresAt } from './account'
import { QQMusicError } from './http'
import { refreshAccountQQAuthorizationIfNeeded } from './auth-refresh'

const expiredRecheckIntervalMs = Number(process.env.QQ_AUTH_EXPIRED_RECHECK_INTERVAL_MS ?? 6 * 60 * 60 * 1000)
const lastExpiredRecheckByUser = new Map<string, number>()

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
  if (account.qqAuthState === 'missing' || !account.qqUin || !account.qqCookie) {
    throw new QQAuthExpiredError('QQ authorization is required. Bind QQ Music to continue.', { code: 'QQ_AUTH_REQUIRED' })
  }
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
    lastExpiredRecheckByUser.set(account.userId, Date.now())
  }

  try {
    const refreshed = await refreshAccountQQAuthorizationIfNeeded(account, {
      force: Boolean(options.force || recheckingExpiredAccount),
    })
    if (refreshed.error) return handleRefreshFailure(account, refreshed.error) as T
    if (refreshed.attempted) {
      logServiceEvent('qq_auth_refresh_applied', {
        userId: refreshed.account.userId,
        refreshed: refreshed.refreshed,
      })
    }
    if (recheckingExpiredAccount) lastExpiredRecheckByUser.delete(account.userId)
    return (getAccountByUserId(refreshed.account.userId) ?? refreshed.account) as T
  } catch (error) {
    return handleRefreshFailure(account, error) as T
  }
}

function handleRefreshFailure(account: AccountRecord, error: unknown): AccountRecord {
  const message = error instanceof Error ? error.message : String(error)
  if (isQQAuthExpiredError(error)) {
    markAccountQQAuthExpired(account.userId, message)
    logServiceEvent('qq_auth_marked_expired', {
      userId: account.userId,
      error: message,
      status: error instanceof QQMusicError ? error.status : undefined,
      payload: summarizeQQAuthErrorPayload(error),
    }, 'error')
    throw new QQAuthExpiredError(message)
  }

  logServiceEvent('qq_auth_refresh_degraded', {
    userId: account.userId,
    error: message,
    status: error instanceof QQMusicError ? error.status : undefined,
    payload: summarizeQQAuthErrorPayload(error),
  }, 'error')
  return getAccountByUserId(account.userId) ?? account
}

function shouldRecheckExpiredAccount(account: AccountRecord, options: { force?: boolean }): boolean {
  if (options.force) return true
  if (!account.qqmusicKey) return false
  const lastAttemptAt = lastExpiredRecheckByUser.get(account.userId)
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
    error: '当前帐号需要完成 QQ 授权。',
    code: 'QQ_AUTH_REQUIRED',
    actionable: '完成或刷新当前帐号的 QQ 授权后再继续使用 XMusic。',
  }, { status: 428 })
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
