import { authenticateUser, markUserLogin } from '@/lib/db/users'
import { readRequestIp } from '@/lib/request-ip'
import { setCurrentAccount } from '@/lib/session'
import { getAccountByUserId, summarizeAccount } from '@/lib/db/accounts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => undefined) as { username?: unknown; password?: unknown } | undefined
  if (typeof body?.username !== 'string' || typeof body.password !== 'string') {
    return Response.json({ error: 'Username and password are required' }, { status: 400 })
  }
  const user = await authenticateUser(body.username, body.password)
  if (!user) return Response.json({ error: 'Invalid username or password', code: 'INVALID_CREDENTIALS' }, { status: 401 })
  markUserLogin(user.id, readRequestIp(request))
  await setCurrentAccount(user.id)
  return Response.json(summarizeAccount(getAccountByUserId(user.id)!))
}
