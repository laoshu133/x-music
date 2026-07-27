import { NextResponse } from 'next/server'
import { qqMusicErrorResponse } from '@/lib/qq'
import { summarizeAccount } from '@/lib/db/accounts'
import { clearCurrentAccount, getCurrentAccount } from '@/lib/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const account = await getCurrentAccount({ verifyQQ: false })
    if (account) return NextResponse.json(summarizeAccount(account))

    return NextResponse.json({
      loggedIn: false,
      actionable: '请注册或登录 XMusic 帐号。',
    })
  } catch (error) {
    return qqMusicErrorResponse(error)
  }
}

export async function DELETE() {
  await clearCurrentAccount()
  return NextResponse.json({ loggedIn: false })
}
