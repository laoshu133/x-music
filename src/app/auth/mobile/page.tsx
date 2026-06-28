import { ExternalLink, Smartphone } from 'lucide-react'
import { headers } from 'next/headers'
import { buildQQMobileAuthorizeUrl, randomAuthState } from '@/lib/qq/mobile-auth'

export const dynamic = 'force-dynamic'

export default async function QQMobileAuthPage() {
  const headerList = await headers()
  const host = headerList.get('x-forwarded-host') ?? headerList.get('host') ?? 'localhost:3004'
  const protocol = headerList.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https')
  const origin = `${protocol}://${host}`
  const callbackUrl = `${origin}/auth/mobile/callback`
  const state = randomAuthState()
  const authorizeUrl = buildQQMobileAuthorizeUrl({ callbackUrl, state, useQQMusicRedirect: true })

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <div className="auth-heading">
          <Smartphone size={26} />
          <div>
            <h1>QQ 手机授权</h1>
            <p>手机完成 QQ 授权后，如果停在 QQ 音乐空白页，把地址栏完整 URL 粘回下方表单。</p>
          </div>
        </div>
        <div className="auth-actions">
          <a className="primary-link" href={authorizeUrl}>
            <ExternalLink size={16} />
            打开 QQ 授权
          </a>
        </div>
        <form className="auth-paste-form" action="/api/account/mobile/exchange" method="post">
          <label htmlFor="mobile-auth-url">授权后的完整 URL</label>
          <textarea
            id="mobile-auth-url"
            name="url"
            placeholder="https://y.qq.com/portal/wx_redirect.html?...&code=..."
          />
          <button type="submit">完成登录</button>
        </form>
      </section>
    </main>
  )
}
