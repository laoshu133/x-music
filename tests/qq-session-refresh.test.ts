import assert from 'node:assert/strict'
import test from 'node:test'
import { replaceQQCookieValues } from '@/lib/qq/account'
import { refreshQQMusickey } from '@/lib/qq/session-refresh'

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.QQ_MUSIC_COOKIE
})

test('replaceQQCookieValues updates musickey cookies without dropping existing values', () => {
  const cookie = replaceQQCookieValues('uin=o123456; qqmusic_key=old; foo=bar', {
    qqmusic_key: 'new-key',
    qm_keyst: 'new-key',
    psrf_musickey_createtime: '1782666210',
  })

  assert.equal(cookie, 'uin=o123456; qqmusic_key=new-key; foo=bar; qm_keyst=new-key; psrf_musickey_createtime=1782666210')
})

test('refreshQQMusickey exchanges current musickey for a new one', async () => {
  const requests: Array<{ url: string; body: any; headers: Headers }> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init)
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      headers: request.headers,
    })
    return Response.json({
      code: 0,
      req1: {
        code: 0,
        data: { musickey: 'next-key' },
      },
    })
  }) as typeof fetch

  const result = await refreshQQMusickey({
    cookie: 'uin=o123456; qm_keyst=old-key; qqmusic_key=old-key; euin=encrypted-uin',
  })

  assert.equal(result.uin, '123456')
  assert.equal(result.musickey, 'next-key')
  assert.equal(result.changed, true)
  assert.match(result.cookie, /qm_keyst=next-key/)
  assert.match(result.cookie, /qqmusic_key=next-key/)
  assert.equal(requests.length, 1)
  assert.match(requests[0].url, /^https:\/\/u\.y\.qq\.com\/cgi-bin\/musics\.fcg\?sign=/)
  assert.equal(requests[0].headers.get('cookie'), 'uin=o123456; qm_keyst=old-key; qqmusic_key=old-key; euin=encrypted-uin')
  assert.deepEqual(requests[0].body.req1.param, {
    expired_in: 7776000,
    musicid: '123456',
    musickey: 'old-key',
  })
})

test('refreshQQMusickey rejects incomplete cookies before remote request', async () => {
  let called = false
  globalThis.fetch = (async () => {
    called = true
    return Response.json({ code: 0 })
  }) as typeof fetch

  await assert.rejects(
    () => refreshQQMusickey({ cookie: 'uin=o123456; euin=encrypted-uin' }),
    /login cookie is incomplete/,
  )
  assert.equal(called, false)
})
