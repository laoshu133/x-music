import { createUser, UsernameTakenError, UsernameValidationError } from '@/lib/db/users'
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
  try {
    const created = await createUser({ username: body.username, password: body.password, loginIp: readRequestIp(request) })
    await setCurrentAccount(created.user.id)
    const account = getAccountByUserId(created.user.id)!
    return Response.json({ ...summarizeAccount(account), generatedPlayerPassword: created.playerPassword }, { status: 201 })
  } catch (error) {
    if (error instanceof UsernameTakenError) return Response.json({ error: error.message, code: 'USERNAME_TAKEN' }, { status: 409 })
    if (error instanceof UsernameValidationError || (error instanceof Error && error.message.startsWith('Password must'))) {
      return Response.json({ error: error.message }, { status: 400 })
    }
    throw error
  }
}
