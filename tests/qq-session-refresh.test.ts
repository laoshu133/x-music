import assert from 'node:assert/strict'
import test from 'node:test'
import { db } from '@/lib/db'
import { getAccountByQQ, type AccountRecord } from '@/lib/db/accounts'
import { clearQQLoginCookie, getStoredQQLoginState, saveQQLoginCookie } from '@/lib/db/qq-session'
import { buildQQLoginState, parseQQAccessTokenExpiresAt, replaceQQCookieValues } from '@/lib/qq/account'
import { refreshAccountQQAuthorization, refreshAccountQQAuthorizationIfNeeded } from '@/lib/qq/auth-refresh'
import { requireActiveQQAccount } from '@/lib/qq/auth-state'
import { refreshQQMusickey } from '@/lib/qq/session-refresh'

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.QQ_MUSIC_COOKIE
  clearQQLoginCookie()
})

test('replaceQQCookieValues updates musickey cookies without dropping existing values', () => {
  const cookie = replaceQQCookieValues('uin=o123456; qqmusic_key=old; foo=bar', {
    qqmusic_key: 'new-key',
    qm_keyst: 'new-key',
    psrf_musickey_createtime: '1782666210',
  })

  assert.equal(cookie, 'uin=o123456; qqmusic_key=new-key; foo=bar; qm_keyst=new-key; psrf_musickey_createtime=1782666210')
})

test('QQ login state exposes access token expiration from cookie', () => {
  const expiresAt = parseQQAccessTokenExpiresAt('uin=o123456; qm_keyst=key; psrf_access_token_expiresAt=1787850210')
  const state = buildQQLoginState('uin=o123456; qm_keyst=key; psrf_access_token_expiresAt=1787850210', 'request')

  assert.equal(expiresAt, '2026-08-27T17:03:30.000Z')
  assert.equal(state.accessTokenExpiresAt, expiresAt)
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

test('refreshAccountQQAuthorizationIfNeeded refreshes near-expiring account cookies', async () => {
  const expiresSoon = Math.floor((Date.now() + 60 * 60 * 1000) / 1000)
  db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('123457')
  saveQQLoginCookie(`uin=o123457; qm_keyst=old-key; qqmusic_key=old-key; psrf_access_token_expiresAt=${expiresSoon}`)
  const account = getAccountByQQ('123457')
  assert.ok(account)

  let refreshRequests = 0
  globalThis.fetch = (async (url: string | URL | Request) => {
    assert.match(String(url), /^https:\/\/u6\.y\.qq\.com\/cgi-bin\/musics\.fcg\?sign=/)
    refreshRequests += 1
    return Response.json({
      code: 0,
      'music.login.LoginServer.Login': {
        code: 1000,
        data: {
          musickey: 'next-key',
          access_token: 'access-next',
          refresh_token: 'refresh-next',
          expired_at: 7776000,
        },
      },
    })
  }) as typeof fetch

  try {
    const result = await refreshAccountQQAuthorizationIfNeeded(account, {
      refreshWindowMs: 7 * 24 * 60 * 60 * 1000,
      minIntervalMs: 0,
    })

    assert.equal(result.attempted, true)
    assert.equal(result.refreshed, true)
    assert.equal(result.account.qqmusicKey, 'next-key')
    assert.match(result.account.qqCookie, /psrf_qqaccess_token=access-next/)
    assert.equal(refreshRequests, 1)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('123457')
  }
})

test('refreshAccountQQAuthorization refreshes the selected account without replacing another stored session', async () => {
  db.prepare('DELETE FROM accounts WHERE qq_uin IN (?, ?)').run('123460', '123461')
  saveQQLoginCookie('uin=o123460; qm_keyst=old-current; qqmusic_key=old-current')
  const currentAccount = getAccountByQQ('123460')
  assert.ok(currentAccount)
  saveQQLoginCookie('uin=o123461; qm_keyst=stored-other; qqmusic_key=stored-other')
  assert.equal(getStoredQQLoginState()?.uin, '123461')

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init)
    assert.equal(request.headers.get('cookie'), 'uin=o123460; qm_keyst=old-current; qqmusic_key=old-current')
    return Response.json({
      code: 0,
      'music.login.LoginServer.Login': {
        code: 1000,
        data: { musickey: 'next-current' },
      },
    })
  }) as typeof fetch

  try {
    const result = await refreshAccountQQAuthorization(currentAccount)

    assert.equal(result.account.qqUin, '123460')
    assert.equal(result.account.qqmusicKey, 'next-current')
    assert.match(getAccountByQQ('123460')?.qqCookie ?? '', /qm_keyst=next-current/)
    assert.match(getAccountByQQ('123461')?.qqCookie ?? '', /qm_keyst=stored-other/)
    assert.equal(getStoredQQLoginState()?.uin, '123461')
    assert.match(getStoredQQLoginState()?.cookie ?? '', /qm_keyst=stored-other/)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin IN (?, ?)').run('123460', '123461')
  }
})

test('refreshAccountQQAuthorization rejects mismatched account cookies before saving', async () => {
  const account = {
    qqUin: '999999',
    qqCookie: 'uin=o123462; qm_keyst=old-key; qqmusic_key=old-key',
    qqAuthState: 'active',
  } as AccountRecord

  globalThis.fetch = (async () => Response.json({
    code: 0,
    'music.login.LoginServer.Login': {
      code: 1000,
      data: { musickey: 'next-key' },
    },
  })) as typeof fetch

  await assert.rejects(
    () => refreshAccountQQAuthorization(account),
    /different account/,
  )
  assert.equal(getAccountByQQ('123462'), undefined)
})

test('refreshAccountQQAuthorizationIfNeeded skips accounts outside refresh window', async () => {
  const expiresLater = Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000)
  db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('123458')
  saveQQLoginCookie(`uin=o123458; qm_keyst=old-key; qqmusic_key=old-key; psrf_access_token_expiresAt=${expiresLater}`)
  const account = getAccountByQQ('123458')
  assert.ok(account)

  let refreshRequests = 0
  globalThis.fetch = (async () => {
    refreshRequests += 1
    return Response.json({ code: 0 })
  }) as typeof fetch

  try {
    const result = await refreshAccountQQAuthorizationIfNeeded(account, {
      refreshWindowMs: 7 * 24 * 60 * 60 * 1000,
      minIntervalMs: 0,
    })

    assert.equal(result.attempted, false)
    assert.equal(result.account.qqmusicKey, 'old-key')
    assert.equal(refreshRequests, 0)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('123458')
  }
})

test('requireActiveQQAccount force refreshes and retries once after auth rejection', async () => {
  db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('123459')
  saveQQLoginCookie('uin=o123459; qm_keyst=old-key; qqmusic_key=old-key')
  const account = getAccountByQQ('123459')
  assert.ok(account)

  let profileRequests = 0
  let refreshRequests = 0
  globalThis.fetch = (async (url: string | URL | Request) => {
    const requestUrl = String(url)
    if (requestUrl.startsWith('https://u6.y.qq.com/cgi-bin/musics.fcg')) {
      refreshRequests += 1
      return Response.json({
        code: 0,
        'music.login.LoginServer.Login': {
          code: 1000,
          data: { musickey: 'retry-key' },
        },
      })
    }

    profileRequests += 1
    if (profileRequests === 1) return Response.json({ code: -1000, message: '请登录' })
    return Response.json({
      code: 0,
      data: {
        creator: {
          nick: 'Retry User',
          headpic: '',
        },
      },
    })
  }) as typeof fetch

  try {
    const result = await requireActiveQQAccount(account, { force: true })

    assert.equal(result?.qqmusicKey, 'retry-key')
    assert.equal(getAccountByQQ('123459')?.qqAuthState, 'active')
    assert.equal(refreshRequests, 1)
    assert.equal(profileRequests, 2)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('123459')
  }
})
