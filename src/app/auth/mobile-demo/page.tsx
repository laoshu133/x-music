import { Smartphone, ExternalLink } from 'lucide-react'
import { headers } from 'next/headers'
import { buildQQMobileAuthorizeUrl, randomAuthState } from '@/lib/qq/mobile-auth-demo'

export const dynamic = 'force-dynamic'

export default async function QQMobileAuthDemoPage() {
  const headerList = await headers()
  const host = headerList.get('x-forwarded-host') ?? headerList.get('host') ?? 'localhost:3004'
  const protocol = headerList.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https')
  const origin = `${protocol}://${host}`
  const callbackUrl = `${origin}/auth/mobile-demo/callback`
  const state = randomAuthState()
  const qqMusicRedirectUrl = buildQQMobileAuthorizeUrl({ callbackUrl, state, useQQMusicRedirect: true })
  const directCallbackUrl = buildQQMobileAuthorizeUrl({ callbackUrl, state: `${state}-direct` })

  return (
    <main className="demo-page">
      <section className="demo-panel">
        <div className="demo-heading">
          <Smartphone size={26} />
          <div>
            <h1>QQ 手机授权 Demo</h1>
            <p>用手机打开此页，先点 QQ 音乐中转授权。授权结束后回调页会显示是否拿到 code。</p>
          </div>
        </div>
        <div className="demo-actions">
          <a className="primary-link" href={qqMusicRedirectUrl}>
            <ExternalLink size={16} />
            QQ 音乐中转授权
          </a>
          <a className="secondary-link" href={directCallbackUrl}>
            <ExternalLink size={16} />
            直接回调授权
          </a>
        </div>
        <dl className="demo-facts">
          <div><dt>回调地址</dt><dd>{callbackUrl}</dd></div>
          <div><dt>授权模式</dt><dd>QQ Connect authorize + display=mobile</dd></div>
        </dl>
      </section>
    </main>
  )
}
