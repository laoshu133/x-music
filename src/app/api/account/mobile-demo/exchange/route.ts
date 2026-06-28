import { NextResponse } from 'next/server'
import { getAccountByQQ, refreshAccountQQProfile, summarizeAccount } from '@/lib/db/accounts'
import { saveQQLoginCookie } from '@/lib/db/qq-session'
import { exchangeQQMusicLoginCode, qqMusicErrorResponse } from '@/lib/qq'
import { readRequestIp } from '@/lib/request-ip'
import { setCurrentAccount } from '@/lib/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const code = await readCode(request)
  if (!code) return NextResponse.json({ error: 'Missing code' }, { status: 400 })

  try {
    const session = await exchangeQQMusicLoginCode({ code })
    const saved = saveQQLoginCookie(session.cookie, { loginIp: readRequestIp(request) })
    await setCurrentAccount(saved.uin)
    const profiledAccount = await refreshAccountQQProfile(saved.uin).catch(() => undefined)
    const account = profiledAccount ?? getAccountByQQ(saved.uin)

    return NextResponse.json({
      isOk: true,
      message: '登录成功',
      uin: saved.uin,
      hasQQMusicKey: saved.hasQQMusicKey,
      account: account ? summarizeAccount(account) : saved,
    })
  } catch (error) {
    return qqMusicErrorResponse(error)
  }
}

async function readCode(request: Request): Promise<string | undefined> {
  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => undefined) as { code?: string } | undefined
    return body?.code?.trim()
  }
  const form = await request.formData().catch(() => undefined)
  return form?.get('code')?.toString().trim()
}
