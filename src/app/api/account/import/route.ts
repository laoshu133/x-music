import { NextResponse } from 'next/server'
import { buildQQLoginState, qqMusicErrorResponse, summarizeQQLoginState } from '@/lib/qq'
import { getAccountByQQ } from '@/lib/db/accounts'
import { saveQQLoginCookie } from '@/lib/db/qq-session'
import { ensureUpstreamEmbyUserForAccount } from '@/lib/emby/auth'
import { setCurrentAccount } from '@/lib/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type ImportRequest = {
  cookie?: string
  persist?: boolean
}

export async function POST(request: Request) {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return NextResponse.json({ error: 'POST /api/account/import expects application/json' }, { status: 415 })
  }

  const body = (await request.json().catch(() => undefined)) as ImportRequest | undefined
  if (!body?.cookie) {
    return NextResponse.json({ error: 'Missing cookie' }, { status: 400 })
  }

  try {
    if (body.persist !== false) {
      const saved = saveQQLoginCookie(body.cookie)
      await setCurrentAccount(saved.uin)
      const account = getAccountByQQ(saved.uin)
      const upstreamAccount = account ? await ensureUpstreamEmbyUserForAccount(account).catch(() => undefined) : undefined
      return NextResponse.json({
        ...saved,
        emby: upstreamAccount ? { ...saved.emby, userId: upstreamAccount.embyUserId } : saved.emby,
        persisted: true,
      })
    }

    const state = buildQQLoginState(body.cookie, 'request')
    return NextResponse.json({
      ...summarizeQQLoginState(state),
      persisted: false,
      actionable: 'This validates the cookie shape without saving it.',
    })
  } catch (error) {
    return qqMusicErrorResponse(error)
  }
}
