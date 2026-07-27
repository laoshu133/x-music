import { summarizeAccount } from '@/lib/db/accounts'
import { QQAuthExpiredError } from '@/lib/qq/auth-state'
import { getCurrentAccount } from '@/lib/session'
import { logServiceEvent } from '@/lib/request-log'

export async function getInitialAccount() {
  let account
  try {
    account = await getCurrentAccount({ verifyQQ: false })
  } catch (error) {
    if (isNextDynamicServerSignal(error)) throw error
    if (error instanceof QQAuthExpiredError) return {
      loggedIn: false,
      actionable: '重新完成 QQ 授权登录后再继续使用 XMusic。',
    }
    logServiceEvent('initial_account_load_failed', {
      error: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
    }, 'error')
    return {
      loggedIn: false,
      systemError: true,
      actionable: '系统出错，请稍后重试。后台已记录错误。',
    }
  }
  return account
    ? summarizeAccount(account)
    : {
        loggedIn: false,
        actionable: '请注册或登录 XMusic 帐号。',
      }
}

function isNextDynamicServerSignal(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as { digest?: unknown; message?: unknown }
  return record.digest === 'DYNAMIC_SERVER_USAGE'
    || (typeof record.message === 'string' && record.message.startsWith('Dynamic server usage:'))
}
