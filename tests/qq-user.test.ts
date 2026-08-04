import assert from 'node:assert/strict'
import test from 'node:test'

import { QQMusicError } from '@/lib/qq/http'
import { getQQUserPlaylists } from '@/lib/qq/user'

test('getQQUserPlaylists reads and maps PlaylistBaseRead results', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      assert.equal(requestUrl.hostname, 'u.y.qq.com')
      assert.ok(requestUrl.searchParams.get('sign'))
      assert.equal(new Headers(init?.headers).get('cookie'), 'uin=o123456; qm_keyst=test-key')

      const body = JSON.parse(String(init?.body))
      assert.equal(body.req.module, 'music.musicasset.PlaylistBaseRead')
      assert.equal(body.req.method, 'GetPlaylistByUin')
      assert.equal(body.req.param.uin, '123456')

      return Response.json({
        code: 0,
        req: {
          code: 0,
          data: {
            total: 2,
            bFinish: true,
            v_playlist: [
              {
                tid: 10001,
                dirId: 201,
                dirName: 'First Playlist',
                songNum: 12,
                updateTime: 1738555506,
                nick: 'Playlist Owner',
                picUrl: 'https://y.qq.com/first.jpg',
                desc: 'First description',
                play_cnt: 12500,
              },
              {
                tid: 10002,
                dirName: 'Second Playlist',
                songNum: 3,
                createTime: 1738469106,
              },
            ],
          },
        },
      })
    }) as typeof fetch

    const result = await getQQUserPlaylists({
      cookie: 'uin=o123456; qm_keyst=test-key',
      offset: 0,
      limit: 1,
    })

    assert.equal(result.total, 2)
    assert.equal(result.allPage, 2)
    assert.deepEqual(result.list, [{
      source: 'tx',
      id: '10001',
      name: 'First Playlist',
      author: 'Playlist Owner',
      img: 'https://y.qq.com/first.jpg',
      desc: 'First description',
      total: 12,
      playCount: '1.3万',
      time: '2025-02-03T04:05:06.000Z',
    }])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('getQQUserPlaylists rejects PlaylistBaseRead business errors', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = (async () => Response.json({
      code: 0,
      req: { code: 1000, data: {} },
    })) as typeof fetch

    await assert.rejects(
      () => getQQUserPlaylists({ cookie: 'uin=o123456; qm_keyst=test-key' }),
      (error: unknown) => error instanceof QQMusicError
        && error.message === 'QQ user playlists request was rejected',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
