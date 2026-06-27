import { NextResponse } from 'next/server'
import { updateAccountEmbyConfig } from '@/lib/db/accounts'
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

  const body = await request.json().catch(() => undefined) as {
    password?: unknown
    baseUrl?: unknown
    apiKey?: unknown
    sourceWebdavDsn?: unknown
    proxyTimeoutMs?: unknown
  } | undefined
  const password = typeof body?.password === 'string' ? body.password.trim() : ''
  if (!password) {
    return NextResponse.json({ error: 'Missing password' }, { status: 400 })
  }

  const updated = updateAccountEmbyConfig(account.qqUin, {
    password,
    baseUrl: optionalString(body?.baseUrl),
    apiKey: optionalString(body?.apiKey),
    sourceWebdavDsn: optionalString(body?.sourceWebdavDsn),
    proxyTimeoutMs: optionalNumber(body?.proxyTimeoutMs),
  })
  if (!updated) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  return NextResponse.json(accountEmbyConfig(updated))
}

function accountEmbyConfig(account: {
  embyUsername: string
  embyPassword: string
  embyBaseUrl?: string
  embyApiKey?: string
  embySourceWebdavDsn?: string
  embyProxyTimeoutMs?: number
}, password = account.embyPassword) {
  return {
    username: account.embyUsername,
    password,
    hasPassword: Boolean(account.embyPassword),
    baseUrl: account.embyBaseUrl,
    hasApiKey: Boolean(account.embyApiKey),
    apiKey: account.embyApiKey ? '********' : '',
    sourceWebdavDsn: account.embySourceWebdavDsn,
    hasSourceWebdavDsn: Boolean(account.embySourceWebdavDsn),
    proxyTimeoutMs: account.embyProxyTimeoutMs ?? 30000,
  }
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : null
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
