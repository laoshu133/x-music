import { listAccounts } from '@/lib/db/accounts'
import { logServiceEvent } from '@/lib/request-log'
import { QQAuthExpiredError, requireActiveQQAccount } from './auth-state'

export interface QQAuthorizationSweepResult {
  checked: number
  active: number
  expired: number
  failed: number
}

export async function sweepQQAuthorizations(): Promise<QQAuthorizationSweepResult> {
  const result: QQAuthorizationSweepResult = {
    checked: 0,
    active: 0,
    expired: 0,
    failed: 0,
  }

  for (const account of listAccounts()) {
    if (account.qqAuthState === 'missing') continue
    result.checked += 1
    try {
      await requireActiveQQAccount(account)
      result.active += 1
    } catch (error) {
      if (error instanceof QQAuthExpiredError) {
        result.expired += 1
        continue
      }
      result.failed += 1
      logServiceEvent('qq_auth_sweep_account_failed', {
        userId: account.userId,
        error: error instanceof Error ? error.message : String(error),
      }, 'error')
    }
  }

  if (result.expired > 0 || result.failed > 0 || healthySweepLogsEnabled()) {
    logServiceEvent('qq_auth_sweep_completed', { ...result }, result.failed ? 'error' : 'info')
  }
  return result
}

function healthySweepLogsEnabled(): boolean {
  return ['1', 'true', 'on', 'yes'].includes(process.env.X_MUSIC_QQ_AUTH_SWEEP_LOG_HEALTHY?.trim().toLowerCase() ?? '')
}
