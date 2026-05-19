import assert from 'node:assert/strict'
import test from 'node:test'
import { setQQFavoriteSong } from '@/lib/qq/favorites'

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.QQ_MUSIC_COOKIE
})

test('setQQFavoriteSong writes like playlist through signed PlaylistDetailWrite request', async () => {
  process.env.QQ_MUSIC_COOKIE = 'uin=o123456; qm_keyst=test-key; euin=encrypted-uin'
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
      req: {
        code: 0,
        data: {
          retCode: 0,
          result: {
            dirId: 201,
            songlist: [{ backendSongId: 449205, songId: 449205, songType: 0 }],
          },
        },
      },
    })
  }) as typeof fetch

  const result = await setQQFavoriteSong({
    cookie: 'uin=o123456; qm_keyst=test-key; euin=encrypted-uin',
    songmid: '003aAYrm3GE0Ac',
    favorited: true,
    raw: { songId: 449205, songType: 0 },
  })

  assert.equal(result.synced, true)
  assert.equal(result.favorited, true)
  assert.equal(requests.length, 1)
  assert.match(requests[0].url, /^https:\/\/u\.y\.qq\.com\/cgi-bin\/musics\.fcg\?sign=/)
  assert.equal(requests[0].headers.get('cookie'), 'uin=o123456; qm_keyst=test-key; euin=encrypted-uin')
  assert.equal(requests[0].body.req.module, 'music.musicasset.PlaylistDetailWrite')
  assert.equal(requests[0].body.req.method, 'AddSonglist')
  assert.deepEqual(requests[0].body.req.param, {
    dirId: 201,
    v_songInfo: [{ songId: 449205, songType: 0 }],
  })
})

test('setQQFavoriteSong reports missing songId before making remote write request', async () => {
  process.env.QQ_MUSIC_COOKIE = 'uin=o123456; qm_keyst=test-key; euin=encrypted-uin'
  let called = false
  globalThis.fetch = (async () => {
    called = true
    return Response.json({ code: 0 })
  }) as typeof fetch

  await assert.rejects(
    () => setQQFavoriteSong({
      cookie: 'uin=o123456; qm_keyst=test-key; euin=encrypted-uin',
      songmid: 'NO_ID',
      favorited: true,
      raw: { songmid: 'NO_ID' },
    }),
    /numeric songId/,
  )
  assert.equal(called, false)
})
