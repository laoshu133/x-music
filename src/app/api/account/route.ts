import { NextResponse } from 'next/server'
import { getQQLoginState, qqMusicErrorResponse, summarizeQQLoginState } from '@/lib/qq'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
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
