import { NextResponse } from 'next/server'
import { qqMusicErrorResponse } from '@/lib/qq'
import { summarizeAccount } from '@/lib/db/accounts'
import { clearCurrentAccount, getCurrentAccount } from '@/lib/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const account = await getCurrentAccount()
    if (account) return NextResponse.json(summarizeAccount(account))

    return NextResponse.json({
      loggedIn: false,
      actionable: 'Scan the QQ login QR code or POST a QQ Music Cookie header string to /api/account/import.',
    })
  } catch (error) {
    return qqMusicErrorResponse(error)
  }
}

export async function DELETE() {
  await clearCurrentAccount()
  return NextResponse.json({ loggedIn: false })
}
