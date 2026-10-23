import assert from 'node:assert/strict'
import test from 'node:test'
import { setQQFavoriteSong } from '@/lib/qq/favorites'
import { syncPendingFavorites } from '@/lib/qq/favorite-sync'
import { getFavoriteStatus, setLocalFavorite } from '@/lib/db/favorites'
import { getAccountByQQ } from '@/lib/db/accounts'
import { clearQQLoginCookie, saveQQLoginCookie } from '@/lib/db/qq-session'
import { db } from '@/lib/db'
import type { MusicInfo } from '@/lib/types'
import { decryptQQMusicAg1Request, qqMusicGtk } from '@/lib/qq/crypto'

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.QQ_MUSIC_COOKIE
  delete process.env.QQ_FAVORITE_SYNC_MAX_ATTEMPTS
  clearQQLoginCookie()
})

test('setQQFavoriteSong writes like playlist through signed PlaylistDetailWrite request', async () => {
  process.env.QQ_MUSIC_COOKIE = 'uin=o123456; qm_keyst=test-key; euin=encrypted-uin'
  const requests: Array<{ url: string; body: any; headers: Headers }> = []

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init)
    const body = JSON.parse(decryptQQMusicAg1Request(String(init?.body)))
    requests.push({
      url: String(url),
      body,
      headers: request.headers,
    })

    if (body?.req_0?.method === 'IsSongFanByMid') {
      return Response.json({
        code: 0,
        req_0: { code: 0, data: { m_fan: { '003aAYrm3GE0Ac': true } } },
      })
    }
    return Response.json({
      code: 0,
      req_0: {
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
  assert.equal(result.verified, true)
  assert.equal(requests.length, 2)
  assert.match(requests[0].url, /^https:\/\/u6\.y\.qq\.com\/cgi-bin\/musics\.fcg\?_=\d+&encoding=ag-1&sign=/)
  assert.equal(requests[0].headers.get('cookie'), 'uin=o123456; qm_keyst=test-key; euin=encrypted-uin')
  assert.equal(requests[0].body.comm.g_tk, qqMusicGtk('test-key'))
  assert.equal(requests[0].body.comm.g_tk_new_20200303, qqMusicGtk('test-key'))
  assert.equal(requests[0].body.req_0.module, 'music.musicasset.PlaylistDetailWrite')
  assert.equal(requests[0].body.req_0.method, 'AddSonglist')
  assert.deepEqual(requests[0].body.req_0.param, {
    dirId: 201,
    tid: 0,
    bFmtUtf8: true,
    v_songInfo: [{ songId: 449205, songType: 0 }],
  })
  assert.equal(requests[1].body.req_0.method, 'IsSongFanByMid')
})

test('setQQFavoriteSong resolves a missing numeric songId before writing', async () => {
  process.env.QQ_MUSIC_COOKIE = 'uin=o123456; qm_keyst=test-key; euin=encrypted-uin'
  const requests: Array<{ pathname: string; body: any }> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = new URL(String(url))
    const body = requestUrl.hostname === 'u6.y.qq.com'
      ? JSON.parse(decryptQQMusicAg1Request(String(init?.body)))
      : JSON.parse(String(init?.body))
    requests.push({ pathname: requestUrl.pathname, body })
    if (requestUrl.pathname.endsWith('/musicu.fcg')) {
      return Response.json({
        code: 0,
        songinfo: {
          code: 0,
          data: {
            track_info: {
              id: 778899,
              mid: 'NO_ID',
              title: 'Resolved Song',
              singer: [{ name: 'Resolved Artist' }],
              album: { name: 'Resolved Album', mid: 'resolved-album' },
              file: { media_mid: 'NO_ID', size_320mp3: 1024 },
            },
          },
        },
      })
    }
    if (body?.req_0?.method === 'IsSongFanByMid') {
      return Response.json({
        code: 0,
        req_0: { code: 0, data: { m_fan: { 'NO_ID': true } } },
      })
    }
    return Response.json({ code: 0, req_0: { code: 0 } })
  }) as typeof fetch

  await setQQFavoriteSong({
    cookie: 'uin=o123456; qm_keyst=test-key; euin=encrypted-uin',
    songmid: 'NO_ID',
    favorited: true,
    raw: { songmid: 'NO_ID' },
  })
  assert.equal(requests.length, 3)
  assert.equal(requests[0].pathname, '/cgi-bin/musicu.fcg')
  assert.match(requests[1].pathname, /\/cgi-bin\/musics\.fcg$/)
  assert.deepEqual(requests[1].body.req_0.param.v_songInfo, [{ songId: 778899, songType: 0 }])
  assert.equal(requests[2].body.req_0.method, 'IsSongFanByMid')
})

test('setQQFavoriteSong accepts idempotent remove only when readback confirms the state', async () => {
  let method = ''
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(decryptQQMusicAg1Request(String(init?.body)))
    method = body.req_0.method
    if (method === 'IsSongFanByMid') {
      return Response.json({
        code: 0,
        req_0: { code: 0, data: { m_fan: { '003aAYrm3GE0Ac': false } } },
      })
    }
    return Response.json({
      code: 0,
      req_0: { code: 80105, data: { retCode: 0 } },
    })
  }) as typeof fetch

  const result = await setQQFavoriteSong({
    cookie: 'uin=o123456; qm_keyst=test-key; euin=encrypted-uin',
    songmid: '003aAYrm3GE0Ac',
    favorited: false,
    raw: { songId: 449205, songType: 0 },
  })

  assert.equal(method, 'IsSongFanByMid')
  assert.equal(result.synced, true)
  assert.equal(result.verified, true)
})

test('setQQFavoriteSong rejects a mutation when readback keeps the old favorite state', async () => {
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(decryptQQMusicAg1Request(String(init?.body)))
    if (body.req_0.method === 'IsSongFanByMid') {
      return Response.json({
        code: 0,
        req_0: { code: 0, data: { m_fan: { '003aAYrm3GE0Ac': true } } },
      })
    }
    return Response.json({ code: 0, req_0: { code: 0, data: { retCode: 0 } } })
  }) as typeof fetch

  await assert.rejects(
    () => setQQFavoriteSong({
      cookie: 'uin=o123456; qm_keyst=test-key; euin=encrypted-uin',
      songmid: '003aAYrm3GE0Ac',
      favorited: false,
      raw: { songId: 449205, songType: 0 },
    }),
    /did not match the requested action/,
  )
})

test('syncPendingFavorites moves a successful pending favorite to synced', async () => {
  const account = testAccount('670001')
  const song = testSong('pending-favorite-success', 670001)
  setLocalFavorite(song, true, account.userId)
  globalThis.fetch = (async () => Response.json({
    code: 0,
    req: { code: 0, data: { retCode: 0 } },
  })) as typeof fetch

  const result = await syncPendingFavorites({
    userId: account.userId,
    cookie: account.qqCookie,
  })

  assert.equal(result.total, 1)
  assert.equal(result.synced, 1)
  assert.equal(result.deferred, 0)
  const status = getFavoriteStatus('tx', song.songmid, account.userId)
  assert.equal(status.favorite, true)
  assert.equal(status.syncState, 'synced')
  assert.equal(status.error, undefined)
})

test('syncPendingFavorites schedules retry with backoff after a transient failure', async () => {
  const account = testAccount('670002')
  const song = testSong('pending-favorite-retry', 670002)
  setLocalFavorite(song, true, account.userId)
  globalThis.fetch = (async () => Response.json({
    code: 1,
    req: { code: 1, subcode: 860100001, trace: 'test-trace' },
  })) as typeof fetch

  const result = await syncPendingFavorites({
    userId: account.userId,
    cookie: account.qqCookie,
  })
  assert.equal(result.deferred, 1)
  assert.equal(result.failed, 0)

  const status = getFavoriteStatus('tx', song.songmid, account.userId)
  assert.equal(status.syncState, 'pending')
  assert.match(status.error ?? '', /request was rejected/)
  const row = db.prepare(`
    SELECT attempts, next_retry_at AS nextRetryAt
    FROM user_favorites uf
    INNER JOIN tracks t ON t.id = uf.track_id
    WHERE uf.user_id = ? AND t.songmid = ?
  `).get(account.userId, song.songmid) as { attempts: number; nextRetryAt: string | null }
  assert.equal(row.attempts, 1)
  assert.ok(row.nextRetryAt)

  const notDue = await syncPendingFavorites({
    userId: account.userId,
    cookie: account.qqCookie,
  })
  assert.equal(notDue.total, 0)
})

test('syncPendingFavorites marks a favorite failed after max attempts', async () => {
  process.env.QQ_FAVORITE_SYNC_MAX_ATTEMPTS = '1'
  const account = testAccount('670003')
  const song = testSong('pending-favorite-failed', 670003)
  setLocalFavorite(song, true, account.userId)
  globalThis.fetch = (async () => Response.json({
    code: 1,
    req: { code: 1, subcode: 860100001 },
  })) as typeof fetch

  const result = await syncPendingFavorites({
    userId: account.userId,
    cookie: account.qqCookie,
  })

  assert.equal(result.failed, 1)
  assert.equal(result.deferred, 0)
  const status = getFavoriteStatus('tx', song.songmid, account.userId)
  assert.equal(status.syncState, 'failed')
})

test('manual favorite sync retries terminal failures', async () => {
  process.env.QQ_FAVORITE_SYNC_MAX_ATTEMPTS = '1'
  const account = testAccount('670004')
  const song = testSong('pending-favorite-manual-retry', 670004)
  setLocalFavorite(song, true, account.userId)
  globalThis.fetch = (async () => Response.json({
    code: 1,
    req: { code: 1, subcode: 860100001 },
  })) as typeof fetch

  const first = await syncPendingFavorites({
    userId: account.userId,
    cookie: account.qqCookie,
  })
  assert.equal(first.failed, 1)
  assert.equal(getFavoriteStatus('tx', song.songmid, account.userId).syncState, 'failed')

  globalThis.fetch = (async () => Response.json({
    code: 0,
    req: { code: 0, data: { retCode: 0 } },
  })) as typeof fetch
  const retried = await syncPendingFavorites({
    userId: account.userId,
    cookie: account.qqCookie,
    includeFailed: true,
    includeFuture: true,
  })
  assert.equal(retried.synced, 1)
  assert.equal(getFavoriteStatus('tx', song.songmid, account.userId).syncState, 'synced')
})

function testAccount(uin: string) {
  saveQQLoginCookie(`uin=o${uin}; qm_keyst=test-key; euin=encrypted-${uin}`)
  const account = getAccountByQQ(uin)
  assert.ok(account)
  return account
}

function testSong(songmid: string, songId: number): MusicInfo {
  return {
    source: 'tx',
    songmid,
    name: `Favorite ${songmid}`,
    singer: 'Favorite Test Artist',
    albumName: 'Favorite Test Album',
    raw: { songId, songType: 0 },
  }
}
