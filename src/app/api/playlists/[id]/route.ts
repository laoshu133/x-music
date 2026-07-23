import { NextResponse } from 'next/server'
import { getQQPlaylistDetail } from '@/lib/qq'
import { isAuthResponse, requireUserAccount } from '@/lib/api-auth'

export const runtime = 'nodejs'

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const account = await requireUserAccount()
  if (isAuthResponse(account)) return account
  const { id } = await context.params
  return NextResponse.json(await getQQPlaylistDetail(id))
}
