import { isAdminQQ, type AccountRecord } from '@/lib/db/accounts'
import { getCurrentAccount } from '@/lib/session'

export async function getCurrentAdminAccount(): Promise<AccountRecord | undefined> {
  const account = await getCurrentAccount()
  return isAdminQQ(account?.qqUin) ? account : undefined
}

export async function requireAdmin(): Promise<Response | undefined> {
  const admin = await getCurrentAdminAccount()
  if (admin) return undefined
  return Response.json({ error: 'Admin permission required' }, { status: 403 })
}
