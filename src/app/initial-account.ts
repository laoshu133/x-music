import { summarizeAccount } from '@/lib/db/accounts'
import { getCurrentAccount } from '@/lib/session'

export async function getInitialAccount() {
  const account = await getCurrentAccount({ verifyQQ: false })
  return account
    ? summarizeAccount(account)
    : {
        loggedIn: false,
        actionable: 'Scan the QQ login QR code or POST a QQ Music Cookie header string to /api/account/import.',
      }
}
