import {
  markAccountQQAuthChecked,
  markAccountQQAuthExpired,
  type AccountRecord,
} from '@/lib/db/accounts'
import { logServiceEvent } from '@/lib/request-log'
import { getQQUserProfile } from './user'
import { QQMusicError } from './http'
import { refreshAccountQQAuthorizationIfNeeded } from './auth-refresh'

const defaultCheckTtlMs = Number(process.env.QQ_AUTH_CHECK_TTL_MS ?? 5 * 60 * 1000)

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
  if (account.qqAuthState === 'expired') {
    throw new QQAuthExpiredError(account.qqAuthError ?? undefined)
  }
  const refreshed = await refreshAccountQQAuthorizationIfNeeded(account)
  const currentAccount = refreshed.account
  if (!options.force && isRecentlyChecked(currentAccount.qqAuthCheckedAt)) return currentAccount as T

  try {
    await getQQUserProfile({ uin: currentAccount.qqUin, cookie: currentAccount.qqCookie })
    markAccountQQAuthChecked(currentAccount.qqUin)
    if (refreshed.attempted) {
      logServiceEvent('qq_auth_check_after_refresh_success', {
        qqUin: currentAccount.qqUin,
        refreshed: refreshed.refreshed,
      })
    }
    return currentAccount as T
  } catch (error) {
    if (isQQAuthExpiredError(error)) {
      logServiceEvent('qq_auth_check_rejected', {
        qqUin: currentAccount.qqUin,
        error: error instanceof Error ? error.message : String(error),
        status: error instanceof QQMusicError ? error.status : undefined,
        willRetryRefresh: true,
      }, 'error')
      try {
        const retry = await refreshAccountQQAuthorizationIfNeeded(currentAccount, { force: true })
        await getQQUserProfile({ uin: retry.account.qqUin, cookie: retry.account.qqCookie })
        markAccountQQAuthChecked(retry.account.qqUin)
        logServiceEvent('qq_auth_check_retry_success', {
          qqUin: retry.account.qqUin,
          refreshed: retry.refreshed,
        })
        return retry.account as T
      } catch (retryError) {
        const message = error instanceof Error ? error.message : String(error)
        markAccountQQAuthExpired(currentAccount.qqUin, message)
        logServiceEvent('qq_auth_marked_expired', {
          qqUin: currentAccount.qqUin,
          originalError: message,
          retryError: retryError instanceof Error ? retryError.message : String(retryError),
          retryStatus: retryError instanceof QQMusicError ? retryError.status : undefined,
        }, 'error')
        throw new QQAuthExpiredError(message)
      }
    }
    throw error
  }
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
    || message.includes('qq user playlists request was rejected')
    || message.includes('请登录')
    || message.includes('登录')
}

export function qqAuthExpiredResponse(error?: unknown): Response {
  const message = error instanceof Error ? error.message : 'QQ authorization has expired. Reauthorize QQ Music to continue.'
  return Response.json({
    error: message,
    code: 'QQ_AUTH_EXPIRED',
    actionable: '重新完成 QQ 授权登录后再继续使用 XMusic。',
  }, { status: 401 })
}

function isRecentlyChecked(checkedAt: string | undefined): boolean {
  if (process.env.NODE_ENV === 'test') return true
  if (!checkedAt) return false
  const time = Date.parse(checkedAt)
  return Number.isFinite(time) && Date.now() - time < defaultCheckTtlMs
}

function isQQAuthExpiredPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const record = payload as Record<string, unknown>
  const code = record.code
  if (code === 401 || code === '401') return true

  for (const key of ['message', 'msg', 'error', 'errMsg', 'desc', 'actionable']) {
    const value = record[key]
    if (typeof value === 'string' && isQQAuthExpiredMessage(value)) return true
  }

  return false
}
