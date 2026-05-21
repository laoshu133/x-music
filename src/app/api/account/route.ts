import { NextResponse } from 'next/server'
import { getQQLoginState, qqMusicErrorResponse, summarizeQQLoginState } from '@/lib/qq'
import { summarizeAccount } from '@/lib/db/accounts'
import { clearCurrentAccount, getCurrentAccount } from '@/lib/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const account = await getCurrentAccount()
    if (account) return NextResponse.json(summarizeAccount(account))

    const state = getQQLoginState()
    if (!state) {
      return NextResponse.json({
        loggedIn: false,
        actionable: 'POST a QQ Music Cookie header string to /api/account/import or set QQ_MUSIC_COOKIE.',
      })
    }

    return NextResponse.json(summarizeQQLoginState(state))
  } catch (error) {
    return qqMusicErrorResponse(error)
  }
}

export async function DELETE() {
  await clearCurrentAccount()
  return NextResponse.json({ loggedIn: false })
}
