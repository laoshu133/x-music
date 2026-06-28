import { CheckCircle2, KeyRound, XCircle } from 'lucide-react'

export const dynamic = 'force-dynamic'

export default function QQMobileAuthCallbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  return <CallbackContent searchParams={searchParams} />
}

async function CallbackContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const code = single(params.code)
  const error = single(params.error) ?? single(params.error_description)
  const state = single(params.state)
  const hasCode = Boolean(code)

  return (
    <main className="demo-page">
      <section className="demo-panel">
        <div className="demo-heading">
          {hasCode ? <CheckCircle2 size={26} /> : <XCircle size={26} />}
          <div>
            <h1>{hasCode ? '已收到授权 Code' : '未收到授权 Code'}</h1>
            <p>{hasCode ? '下一步可以尝试把 code 换成 QQ 音乐登录态。' : error ?? '授权服务没有返回 code。'}</p>
          </div>
        </div>
        <dl className="demo-facts">
          <div><dt>Code</dt><dd>{code ? mask(code) : '-'}</dd></div>
          <div><dt>State</dt><dd>{state ?? '-'}</dd></div>
        </dl>
        {code ? (
          <form className="demo-actions" action="/api/account/mobile-demo/exchange" method="post">
            <input type="hidden" name="code" value={code} />
            <button type="submit">
              <KeyRound size={16} />
              尝试换取登录态
            </button>
          </form>
        ) : null}
      </section>
    </main>
  )
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function mask(value: string) {
  return value.length <= 10 ? value : `${value.slice(0, 5)}...${value.slice(-5)}`
}
