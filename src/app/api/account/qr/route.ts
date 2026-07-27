import { NextResponse } from 'next/server'
import { getQQLoginQr, qqMusicErrorResponse } from '@/lib/qq'
import { getCurrentAccount } from '@/lib/session'
import { createQQAuthAttempt } from '@/lib/db/qq-auth-attempts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const account = await getCurrentAccount({ verifyQQ: false })
  if (!account) {
    return NextResponse.json({ error: '请先登录', code: 'AUTH_REQUIRED' }, { status: 401 })
  }
  try {
    const qr = await getQQLoginQr()
    const attemptId = createQQAuthAttempt({
      userId: account.userId,
      method: 'qr',
      verifier: qr.qrsig,
      payload: { ptqrtoken: qr.ptqrtoken, qrsig: qr.qrsig },
    })
    return NextResponse.json({ img: qr.img, attemptId })
  } catch (error) {
    return qqMusicErrorResponse(error)
  }
}
