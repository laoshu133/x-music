import { NextResponse } from 'next/server'
import { regenerateAccountEmbyPassword } from '@/lib/db/accounts'
import { getCurrentAccount } from '@/lib/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  const account = await getCurrentAccount()
  if (!account) return NextResponse.json({ error: 'Login required' }, { status: 401 })
  return NextResponse.json(accountEmbyConfig(account))
}

export async function POST(request: Request): Promise<Response> {
  const account = await getCurrentAccount()
  if (!account) return NextResponse.json({ error: 'Login required' }, { status: 401 })

  const body = await request.json().catch(() => undefined) as { action?: string } | undefined
  if (body?.action !== 'regenerate-password') {
    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 })
  }

  const updated = regenerateAccountEmbyPassword(account.qqUin)
  if (!updated) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  return NextResponse.json(accountEmbyConfig(updated))
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
