import { NextResponse } from 'next/server'
import { buildQQLoginState, checkQQLoginQr, qqMusicErrorResponse, summarizeQQLoginState } from '@/lib/qq'
import { getAccountByQQ } from '@/lib/db/accounts'
import { saveQQLoginCookie } from '@/lib/db/qq-session'
import { ensureUpstreamEmbyUserForAccount } from '@/lib/emby/auth'
import { setCurrentAccount } from '@/lib/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type CheckRequest = {
  ptqrtoken?: string | number
  qrsig?: string
  persist?: boolean
}

export async function POST(request: Request) {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return NextResponse.json({ error: 'POST /api/account/qr/check expects application/json' }, { status: 415 })
  }

  const body = (await request.json().catch(() => undefined)) as CheckRequest | undefined
  if (!body?.ptqrtoken || !body.qrsig) {
    return NextResponse.json({ error: 'Missing ptqrtoken or qrsig' }, { status: 400 })
  }

  try {
    const result = await checkQQLoginQr({
      ptqrtoken: body.ptqrtoken,
      qrsig: body.qrsig,
    })

    if (!result.isOk) return NextResponse.json(result)

    if (body.persist !== false) {
      const saved = saveQQLoginCookie(result.session.cookie)
      await setCurrentAccount(saved.uin)
      const account = getAccountByQQ(saved.uin)
      const upstreamAccount = account ? await ensureUpstreamEmbyUserForAccount(account).catch(() => undefined) : undefined
      return NextResponse.json({
        ...result,
        account: {
          ...saved,
          emby: upstreamAccount ? { ...saved.emby, userId: upstreamAccount.embyUserId } : saved.emby,
          persisted: true,
        },
      })
    }

    const state = buildQQLoginState(result.session.cookie, 'request')
    return NextResponse.json({
      ...result,
      account: {
        ...summarizeQQLoginState(state),
        persisted: false,
      },
    })
  } catch (error) {
    return qqMusicErrorResponse(error)
  }
}
