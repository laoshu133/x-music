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
    const requestUrl = new URL(String(url))
    requests.push({
      url: String(url),
      body: JSON.parse(requestUrl.searchParams.get('data') ?? '{}'),
      headers: request.headers,
    })
    return Response.json({
      code: 0,
      'music.login.LoginServer.Login': {
        code: 1000,
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
  assert.match(requests[0].url, /^https:\/\/u6\.y\.qq\.com\/cgi-bin\/musics\.fcg\?sign=/)
  assert.equal(requests[0].headers.get('cookie'), 'uin=o123456; qm_keyst=old-key; qqmusic_key=old-key; euin=encrypted-uin')
  assert.deepEqual(requests[0].body['music.login.LoginServer.Login'].param, {
    qq: '123456',
    musickey: 'old-key',
  })
})

test('refreshQQMusickey preserves musickey when upstream only refreshes QQ tokens', async () => {
  globalThis.fetch = (async () => Response.json({
    code: 0,
    'music.login.LoginServer.Login': {
      code: 1000,
      data: {
        access_token: 'access-next',
        refresh_token: 'refresh-next',
        expired_at: 7776000,
        musickey: '',
      },
    },
  })) as typeof fetch

  const result = await refreshQQMusickey({
    cookie: 'uin=o123456; qm_keyst=old-key; qqmusic_key=old-key; psrf_qqaccess_token=access-old; psrf_qqrefresh_token=refresh-old',
  })

  assert.equal(result.keyRefreshed, false)
  assert.equal(result.tokenRefreshed, true)
  assert.match(result.cookie, /qm_keyst=old-key/)
  assert.match(result.cookie, /qqmusic_key=old-key/)
  assert.match(result.cookie, /psrf_qqaccess_token=access-next/)
  assert.match(result.cookie, /psrf_qqrefresh_token=refresh-next/)
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
