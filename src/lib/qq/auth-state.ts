import {
  markAccountQQAuthChecked,
  markAccountQQAuthExpired,
  type AccountRecord,
} from '@/lib/db/accounts'
import { getQQUserProfile } from './user'
import { QQMusicError } from './http'

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
  if (!options.force && isRecentlyChecked(account.qqAuthCheckedAt)) return account

  try {
    await getQQUserProfile({ uin: account.qqUin, cookie: account.qqCookie })
    markAccountQQAuthChecked(account.qqUin)
    return account
  } catch (error) {
    if (isQQAuthExpiredError(error)) {
      const message = error instanceof Error ? error.message : String(error)
      markAccountQQAuthExpired(account.qqUin, message)
      throw new QQAuthExpiredError(message)
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
