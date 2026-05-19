import assert from 'node:assert/strict'
import test from 'node:test'
import { syncQQPlayHistory } from '@/lib/qq/history'

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.QQ_MUSIC_COOKIE
})

test('syncQQPlayHistory reports playback through QQ webreport when raw songId exists', async () => {
  const requests: Array<{ url: URL; method: string; headers: Headers }> = []

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init)
    requests.push({
      url: new URL(request.url),
      method: request.method,
      headers: request.headers,
    })
    return new Response('input id[123456]', {
      status: 200,
      headers: { 'content-type': 'text/html;charset=gb2312' },
    })
  }) as typeof fetch

  const result = await syncQQPlayHistory({
    cookie: 'uin=o123456; qm_keyst=test-key; euin=encrypted-uin',
    quality: 'flac',
    musicInfo: {
      source: 'tx',
      songmid: '003aAYrm3GE0Ac',
      name: '稻香',
      singer: '周杰伦',
      interval: '3:43',
      raw: { songId: 449205, songType: 0 },
    },
  })

  assert.equal(result.synced, true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'GET')
  assert.equal(requests[0].url.origin, 'https://stat6.y.qq.com')
  assert.equal(requests[0].url.pathname, '/pc/fcgi-bin/cgi_music_webreport.fcg')
  assert.equal(requests[0].url.searchParams.get('Fqq'), '123456')
  assert.equal(requests[0].url.searchParams.get('Fsong_id'), '449205')
  assert.equal(requests[0].url.searchParams.get('Ffromtag1'), '10050')
  assert.equal(requests[0].url.searchParams.get('Ffromtag2'), '449205')
  assert.equal(requests[0].url.searchParams.get('Fplay_time'), '223')
  assert.equal(requests[0].url.searchParams.get('Ftype'), '3')
  assert.equal(requests[0].url.searchParams.get('Fversion'), '1')
  assert.equal(requests[0].headers.get('cookie'), 'uin=o123456; qm_keyst=test-key; euin=encrypted-uin')
})

test('syncQQPlayHistory resolves songId from QQ detail when play URL only has songmid', async () => {
  const requests: Array<{ url: URL; method: string; body?: any }> = []

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({
      url: new URL(request.url),
      method: request.method,
      body,
    })

    if (request.method === 'POST') {
      return Response.json({
        get_song_detail: {
          code: 0,
          data: {
            track_info: {
              id: 449205,
              type: 0,
            },
          },
        },
      })
    }

    return new Response('input id[123456]', { status: 200 })
  }) as typeof fetch

  const result = await syncQQPlayHistory({
    cookie: 'uin=o123456; qm_keyst=test-key; euin=encrypted-uin',
    quality: 'flac',
    musicInfo: {
      source: 'tx',
      songmid: '003aAYrm3GE0Ac',
      name: '稻香',
      singer: '周杰伦',
      interval: '3:43',
      raw: {
        source: 'tx',
        songmid: '003aAYrm3GE0Ac',
        name: '稻香',
        singer: '周杰伦',
      },
    },
  })

  assert.equal(result.synced, true)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].url.href, 'https://u.y.qq.com/cgi-bin/musicu.fcg')
  assert.equal(requests[0].body.get_song_detail.param.song_mid, '003aAYrm3GE0Ac')
  assert.equal(requests[1].method, 'GET')
  assert.equal(requests[1].url.searchParams.get('Fsong_id'), '449205')
})
