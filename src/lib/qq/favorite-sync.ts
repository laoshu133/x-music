import {
  completeFavoriteSyncAttempt,
  failFavoriteSyncAttempt,
  listFavoriteSyncCandidates,
  reconcileLocalFavoritesFromRemote,
  type FavoriteRecord,
  type FavoriteSyncResult,
} from '@/lib/db/favorites'
import { listAccounts, type AccountRecord } from '@/lib/db/accounts'
import { logServiceEvent } from '@/lib/request-log'
import type { MusicInfo } from '@/lib/types'
import { getQQFavoriteSongs, setQQFavoriteSong } from './favorites'
import { QQMusicError } from './http'
import { refreshAccountQQAuthorizationIfNeeded } from './auth-refresh'
import { isQQAuthExpiredError, requireActiveQQAccount } from './auth-state'

const defaultMaxAttempts = 5
const retryBackoffSeconds = [60, 300, 900, 3600]

export interface FavoriteSyncSummary extends FavoriteSyncResult {
  deferred: number
}

export function favoriteSyncMaxAttempts(): number {
  const configured = Number(process.env.QQ_FAVORITE_SYNC_MAX_ATTEMPTS ?? defaultMaxAttempts)
  return Number.isFinite(configured) ? Math.max(1, Math.trunc(configured)) : defaultMaxAttempts
}

export function favoriteSyncRetryDelaySeconds(attempts: number): number {
  const index = Math.max(0, Math.min(Math.trunc(attempts), retryBackoffSeconds.length - 1))
  return retryBackoffSeconds[index]!
}

export function recordFavoriteSyncFailure(input: {
  userId: string
  record: FavoriteRecord
  error: unknown
  maxAttempts?: number
}): ReturnType<typeof failFavoriteSyncAttempt> {
  const detail = favoriteSyncErrorDetail(input.error)
  const failure = failFavoriteSyncAttempt({
    userId: input.userId,
    source: input.record.source,
    songmid: input.record.songmid,
    desiredState: input.record.desiredState,
    error: detail.message,
    retryable: isRetryableFavoriteSyncError(input.error),
    maxAttempts: input.maxAttempts ?? favoriteSyncMaxAttempts(),
    retryDelaySeconds: favoriteSyncRetryDelaySeconds(input.record.attempts),
  })
  logServiceEvent(failure.terminal ? 'qq_favorite_sync_failed' : 'qq_favorite_sync_retry_scheduled', {
    userId: input.userId,
    songmid: input.record.songmid,
    action: input.record.desiredState,
    attempt: failure.attempts,
    terminal: failure.terminal,
    nextRetryAt: failure.nextRetryAt,
    ...detail,
  }, failure.terminal ? 'error' : 'info')
  return failure
}

export async function syncPendingFavorites(input: {
  userId: string
  cookie?: string
  account?: AccountRecord
  limit?: number
  includeFailed?: boolean
  includeFuture?: boolean
}): Promise<FavoriteSyncSummary> {
  const account = input.account ? await refreshAccountForFavorite(input.account) : undefined
  const maxAttempts = favoriteSyncMaxAttempts()
  const pending = listFavoriteSyncCandidates(input.userId, {
    limit: input.limit ?? 50,
    includeFailed: input.includeFailed,
    includeFuture: input.includeFuture,
  })
  const errors: FavoriteSyncResult['errors'] = []
  let synced = 0
  let failed = 0
  let deferred = 0

  for (const record of pending) {
    try {
      await setQQFavoriteSong({
        cookie: account?.qqCookie ?? input.cookie,
        songmid: record.songmid,
        favorited: record.desiredState === 'favorite',
        raw: record.raw,
      })
      const updated = completeFavoriteSyncAttempt(
        input.userId,
        record.source,
        record.songmid,
        record.desiredState,
      )
      if (updated) synced += 1
    } catch (error) {
      const message = favoriteSyncErrorDetail(error).message
      const failure = recordFavoriteSyncFailure({ userId: input.userId, record, error, maxAttempts })
      errors.push({ songmid: record.songmid, error: message })
      if (failure.terminal) failed += 1
      else deferred += 1
    }
  }

  return {
    synced,
    failed,
    deferred,
    total: pending.length,
    errors,
  }
}

export async function processPendingFavoriteSyncs(input: {
  limitPerAccount?: number
} = {}): Promise<boolean> {
  let didWork = false
  for (const storedAccount of listAccounts()) {
    if (storedAccount.status !== 'active' || !storedAccount.qqCookie) continue
    let account: AccountRecord
    try {
      account = await requireActiveQQAccount(storedAccount)
    } catch (error) {
      if (!(error instanceof Error)) throw error
      if (isQQAuthExpiredError(error)) continue
      logServiceEvent('qq_favorite_sync_auth_refresh_failed', {
        userId: storedAccount.userId,
        error: error.message,
        status: error instanceof QQMusicError ? error.status : undefined,
      }, 'error')
      continue
    }
    const result = await syncPendingFavorites({
      userId: account.userId,
      cookie: account.qqCookie,
      limit: input.limitPerAccount ?? 10,
    })
    if (result.total > 0) didWork = true
  }
  return didWork
}

export async function refreshAccountForFavorite(account: AccountRecord): Promise<AccountRecord> {
  const refreshed = await refreshAccountQQAuthorizationIfNeeded(account)
  return refreshed.account
}

export async function pullRemoteFavorites(input: { userId: string; cookie?: string; page?: number; limit?: number }): Promise<{
  source: 'local'
  list: FavoriteRecord[]
  pulled: number
}> {
  const pageLimit = input.limit ?? 100
  const remote = await getQQFavoriteSongs({ cookie: input.cookie, page: input.page ?? 1, limit: pageLimit })
  return {
    source: 'local',
    list: reconcileLocalFavoritesFromRemote(input.userId, remote.list as MusicInfo[]),
    pulled: remote.list.length,
  }
}

function isRetryableFavoriteSyncError(error: unknown): boolean {
  if (!(error instanceof QQMusicError)) return true
  if (error.status === 400 || error.status === 401 || error.status === 403) return false
  return error.status === undefined || error.status === 429 || error.status >= 500
}

function favoriteSyncErrorDetail(error: unknown): {
  message: string
  status?: number
  code?: unknown
  subcode?: unknown
  reqCode?: unknown
  trace?: unknown
  cause?: Record<string, unknown>
} {
  if (error instanceof QQMusicError) {
    const payload = error.payload && typeof error.payload === 'object'
      ? error.payload as Record<string, unknown>
      : undefined
    const response = payload?.response && typeof payload.response === 'object'
      ? payload.response as Record<string, unknown>
      : undefined
    const request = response?.req && typeof response.req === 'object'
      ? response.req as Record<string, unknown>
      : undefined
    return {
      message: error.message,
      status: error.status,
      code: payload?.code ?? response?.code,
      subcode: payload?.subcode ?? request?.subcode ?? request?.subCode,
      reqCode: request?.code,
      trace: payload?.trace ?? request?.trace,
      cause: payload?.cause && typeof payload.cause === 'object'
        ? payload.cause as Record<string, unknown>
        : undefined,
    }
  }

  const cause = error && typeof error === 'object' && 'cause' in error && error.cause && typeof error.cause === 'object'
    ? error.cause as Record<string, unknown>
    : undefined
  return {
    message: error instanceof Error ? error.message : String(error),
    cause: cause
      ? {
          name: cause.name,
          message: cause.message,
          code: cause.code,
          errno: cause.errno,
          syscall: cause.syscall,
          address: cause.address,
          port: cause.port,
        }
      : undefined,
  }
}
