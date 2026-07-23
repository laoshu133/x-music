import { NextResponse } from 'next/server'
import { getQQToplists } from '@/lib/qq'
import { isAuthResponse, requireUserAccount } from '@/lib/api-auth'

export const runtime = 'nodejs'

export async function GET() {
  const account = await requireUserAccount()
  if (isAuthResponse(account)) return account
  return NextResponse.json(await getQQToplists())
}
