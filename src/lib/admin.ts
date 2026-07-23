import type { AccountRecord } from '@/lib/db/accounts'
import { getCurrentAccount } from '@/lib/session'

export async function getCurrentAdminAccount(): Promise<AccountRecord | undefined> {
  const account = await getCurrentAccount({ verifyQQ: false })
  return account?.role === 'admin' && account.status === 'active' ? account : undefined
}

export async function requireAdmin(): Promise<Response | undefined> {
  const admin = await getCurrentAdminAccount()
  if (admin) return undefined
  return Response.json({ error: 'Admin permission required', code: 'FORBIDDEN' }, { status: 403 })
}
