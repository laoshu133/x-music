import type { AccountRecord } from '@/lib/db/accounts'
import { getCurrentAccount } from '@/lib/session'
import { QQAuthExpiredError, qqAuthExpiredResponse } from '@/lib/qq/auth-state'

export async function requireUserAccount(options: { qq?: boolean } = { qq: true }): Promise<AccountRecord | Response> {
  try {
    const account = await getCurrentAccount({ verifyQQ: options.qq !== false })
    return account ?? Response.json({ error: 'Login required', code: 'AUTH_REQUIRED' }, { status: 401 })
  } catch (error) {
    if (error instanceof QQAuthExpiredError) return qqAuthExpiredResponse(error)
    throw error
  }
}

export function isAuthResponse(value: AccountRecord | Response): value is Response {
  return value instanceof Response
}
