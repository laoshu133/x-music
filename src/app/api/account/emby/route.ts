import { NextResponse } from 'next/server'
import { updateAccountEmbyPassword } from '@/lib/db/accounts'
import { getCurrentAccount } from '@/lib/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type UpdateRequest = {
  password?: string
}

export async function GET(): Promise<Response> {
  const account = await getCurrentAccount()
  if (!account) return NextResponse.json({ error: 'Login required' }, { status: 401 })
  return NextResponse.json(accountEmbyConfig(account))
}

export async function PUT(request: Request): Promise<Response> {
  const account = await getCurrentAccount()
  if (!account) return NextResponse.json({ error: 'Login required' }, { status: 401 })

  const body = await request.json().catch(() => undefined) as UpdateRequest | undefined
  const password = body?.password?.trim()
  if (!password) {
    return NextResponse.json({ error: 'Missing password' }, { status: 400 })
  }

  const updated = updateAccountEmbyPassword(account.qqUin, password)
  if (!updated) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  return NextResponse.json(accountEmbyConfig(updated, password))
}

function accountEmbyConfig(account: {
  embyUsername: string
  embyPassword: string
}, password = account.embyPassword) {
  return {
    username: account.embyUsername,
    password,
    hasPassword: Boolean(account.embyPassword),
  }
}
