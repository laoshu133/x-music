import {
  getAccountByUserId,
  updateAccountQQCookie,
  type AccountRecord,
} from '@/lib/db/accounts'
import { logServiceEvent } from '@/lib/request-log'
import { parseQQAccessTokenExpiresAt, parseQQMusickeyCreatedAt } from './account'
import { QQMusicError } from './http'
import { refreshQQMusickey, type QQMusickeyRefreshResult } from './session-refresh'

const defaultRefreshWindowMs = Number(process.env.QQ_AUTH_AUTO_REFRESH_WINDOW_MS ?? 7 * 24 * 60 * 60 * 1000)
const defaultRefreshMinIntervalMs = Number(process.env.QQ_AUTH_AUTO_REFRESH_MIN_INTERVAL_MS ?? 6 * 60 * 60 * 1000)
const defaultRefreshMaxAgeMs = Number(process.env.QQ_AUTH_AUTO_REFRESH_MAX_AGE_MS ?? 24 * 60 * 60 * 1000)
const lastRefreshAttemptByUser = new Map<string, number>()

export interface QQAuthorizationRefreshResult {
  account: AccountRecord
  attempted: boolean
  refreshed: boolean
  error?: unknown
}

export interface AccountQQAuthorizationRefreshResult {
  account: AccountRecord
  result: QQMusickeyRefreshResult
}

export async function refreshAccountQQAuthorization(
  account: AccountRecord,
): Promise<AccountQQAuthorizationRefreshResult> {
  const result = await refreshQQMusickey({ cookie: account.qqCookie })
  if (result.uin !== account.qqUin) {
    throw new QQMusicError('QQ authorization refresh returned a different account', 409, {
      expectedUin: account.qqUin,
      actualUin: result.uin,
    })
  }
  const refreshedAccount = updateAccountQQCookie(account.userId, result.cookie) ?? getAccountByUserId(account.userId) ?? account
  return {
    account: refreshedAccount,
    result,
  }
}

export async function refreshAccountQQAuthorizationIfNeeded(
  account: AccountRecord,
  options: {
    force?: boolean
    refreshWindowMs?: number
    minIntervalMs?: number
    maxAgeMs?: number
  } = {},
): Promise<QQAuthorizationRefreshResult> {
  const decision = getAccountQQAuthorizationRefreshDecision(account, options)
  if (!decision.shouldRefresh) {
    logRefreshSkipped(account, decision)
    return { account, attempted: false, refreshed: false }
  }

  lastRefreshAttemptByUser.set(account.userId, Date.now())
  try {
    const refreshed = await refreshAccountQQAuthorization(account)
    return {
      account: refreshed.account,
      attempted: true,
      refreshed: refreshed.result.changed,
    }
  } catch (error) {
    if (options.force) throw error
    logServiceEvent('qq_auth_refresh_failed', {
      userId: account.userId,
      reason: decision.reason,
      error: error instanceof Error ? error.message : String(error),
      status: error instanceof QQMusicError ? error.status : undefined,
      payload: summarizeRefreshErrorPayload(error),
    }, 'error')
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
    maxAgeMs?: number
  } = {},
): boolean {
  return getAccountQQAuthorizationRefreshDecision(account, options).shouldRefresh
}

export interface QQAuthorizationRefreshDecision {
  shouldRefresh: boolean
  reason:
    | 'force'
    | 'expired'
    | 'missing-musickey'
    | 'near-access-token-expiry'
    | 'session-age'
    | 'outside-refresh-window'
    | 'recently-attempted'
    | 'fresh-session'
  accessTokenExpiresAt?: string
  musickeyCreatedAt?: string
  ageBasis?: 'musickey-created-at' | 'last-login-at' | 'updated-at' | 'created-at'
  ageMs?: number
  msUntilExpiry?: number
  nextAllowedAt?: string
}

export function getAccountQQAuthorizationRefreshDecision(
  account: AccountRecord,
  options: {
    force?: boolean
    refreshWindowMs?: number
    minIntervalMs?: number
    maxAgeMs?: number
  } = {},
): QQAuthorizationRefreshDecision {
  if (options.force) return { shouldRefresh: true, reason: 'force' }
  if (account.qqAuthState === 'expired') return { shouldRefresh: false, reason: 'expired' }
  if (!account.qqmusicKey) return { shouldRefresh: false, reason: 'missing-musickey' }

  const now = Date.now()
  const minIntervalMs = options.minIntervalMs ?? defaultRefreshMinIntervalMs
  const lastAttemptAt = lastRefreshAttemptByUser.get(account.userId)
  if (lastAttemptAt && now - lastAttemptAt < minIntervalMs) {
    return {
      shouldRefresh: false,
      reason: 'recently-attempted',
      nextAllowedAt: new Date(lastAttemptAt + minIntervalMs).toISOString(),
    }
  }

  const expiresAt = parseQQAccessTokenExpiresAt(account.qqCookie)
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : NaN
  const refreshWindowMs = options.refreshWindowMs ?? defaultRefreshWindowMs
  const age = getAccountQQAuthorizationAge(account, now)
  const maxAgeMs = options.maxAgeMs ?? defaultRefreshMaxAgeMs
  if (Number.isFinite(expiresAtMs)) {
    const msUntilExpiry = expiresAtMs - now
    if (msUntilExpiry <= refreshWindowMs) {
      return {
        shouldRefresh: true,
        reason: 'near-access-token-expiry',
        accessTokenExpiresAt: expiresAt,
        msUntilExpiry,
      }
    }
    if (age && age.ageMs >= maxAgeMs) {
      return {
        shouldRefresh: true,
        reason: 'session-age',
        accessTokenExpiresAt: expiresAt,
        musickeyCreatedAt: age.musickeyCreatedAt,
        ageBasis: age.basis,
        ageMs: age.ageMs,
        msUntilExpiry,
      }
    }

    return {
      shouldRefresh: false,
      reason: 'outside-refresh-window',
      accessTokenExpiresAt: expiresAt,
      msUntilExpiry,
    }
  }

  if (age && age.ageMs >= maxAgeMs) {
    return {
      shouldRefresh: true,
      reason: 'session-age',
      musickeyCreatedAt: age.musickeyCreatedAt,
      ageBasis: age.basis,
      ageMs: age.ageMs,
    }
  }

  return {
    shouldRefresh: false,
    reason: 'fresh-session',
    musickeyCreatedAt: age?.musickeyCreatedAt,
    ageBasis: age?.basis,
    ageMs: age?.ageMs,
  }
}

function logRefreshSkipped(account: AccountRecord, decision: QQAuthorizationRefreshDecision): void {
  if (!['1', 'true', 'on', 'yes'].includes(process.env.X_MUSIC_QQ_AUTH_REFRESH_LOG_SKIPS?.trim().toLowerCase() ?? '')) return
  logServiceEvent('qq_auth_refresh_skipped', {
    userId: account.userId,
    reason: decision.reason,
    accessTokenExpiresAt: decision.accessTokenExpiresAt,
    musickeyCreatedAt: decision.musickeyCreatedAt,
    ageBasis: decision.ageBasis,
    ageMs: decision.ageMs,
    msUntilExpiry: decision.msUntilExpiry,
    nextAllowedAt: decision.nextAllowedAt,
  })
}

function getAccountQQAuthorizationAge(account: AccountRecord, now: number): {
  basis: QQAuthorizationRefreshDecision['ageBasis']
  ageMs: number
  musickeyCreatedAt?: string
} | undefined {
  const musickeyCreatedAt = parseQQMusickeyCreatedAt(account.qqCookie)
  const candidates: Array<{ basis: NonNullable<QQAuthorizationRefreshDecision['ageBasis']>; value?: string }> = [
    { basis: 'musickey-created-at', value: musickeyCreatedAt },
    { basis: 'last-login-at', value: account.lastLoginAt },
    { basis: 'updated-at', value: account.updatedAt },
  ]

  const latest = candidates
    .flatMap(candidate => {
      if (!candidate.value) return []
      const time = Date.parse(candidate.value)
      return Number.isFinite(time) ? [{ ...candidate, time }] : []
    })
    .sort((left, right) => right.time - left.time)[0]
  if (latest) {
    return {
      basis: latest.basis,
      ageMs: Math.max(0, now - latest.time),
      musickeyCreatedAt,
    }
  }

  return undefined
}

function summarizeRefreshErrorPayload(error: unknown): unknown {
  if (!(error instanceof QQMusicError) || !error.payload || typeof error.payload !== 'object') return undefined
  const payload = error.payload as Record<string, unknown>
  return {
    code: payload.code,
    actionable: payload.actionable,
    traceid: payload.traceid,
  }
}
