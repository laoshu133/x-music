import { summarizeAccount } from '@/lib/db/accounts'
import { QQAuthExpiredError } from '@/lib/qq/auth-state'
import { getCurrentAccount } from '@/lib/session'

export async function getInitialAccount() {
  const account = await getCurrentAccount().catch((error: unknown) => {
    if (error instanceof QQAuthExpiredError) return undefined
    throw error
  })
  return account
    ? summarizeAccount(account)
    : {
        loggedIn: false,
        actionable: 'Scan the QQ login QR code or POST a QQ Music Cookie header string to /api/account/import.',
      }
}
