import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureTrack, insertPlayEvent, listPlayHistory } from '@/lib/cache/store'
import { db } from '@/lib/db'
import { getQQPlayHistory, syncQQPlayHistory, syncQQPlayHistoryBestEffort } from '@/lib/qq/history'
import { pullQQPlayHistory, pushLocalPlayHistoryToQQ } from '@/lib/qq/history-sync'

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
  db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid IN (?, ?)")
    .run('push-local-qq-history', 'pull-remote-qq-history')
})

test('syncQQPlayHistory writes QQ recent playback through the authenticated JSON endpoint', async () => {
  const requests: Array<{ url: URL; method: string; headers: Headers; body: any }> = []

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init)
    requests.push({
      url: new URL(request.url),
      method: request.method,
      headers: request.headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return Response.json({ code: 0, req: { code: 0, data: { ret: 0, timeList: [] } } })
  }) as typeof fetch

  const result = await syncQQPlayHistory({
    cookie: 'uin=o123456; login_type=1; qm_keyst=test-key; euin=encrypted-uin',
    playedAt: '2026-07-28T09:30:00.000Z',
    musicInfo: {
      source: 'tx',
      songmid: '003aAYrm3GE0Ac',
      name: '稻香',
      singer: '周杰伦',
      raw: { songId: 449205, songType: 0 },
    },
  })

  assert.equal(result.synced, true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].url.origin, 'https://u.y.qq.com')
  assert.equal(requests[0].url.pathname, '/cgi-bin/musics.fcg')
  assert.ok(requests[0].url.searchParams.get('sign'))
  assert.equal(requests[0].headers.get('cookie'), 'uin=o123456; login_type=1; qm_keyst=test-key; euin=encrypted-uin')
  assert.equal(requests[0].body.req.module, 'music.musicasset.PlayRecentlyWrite')
  assert.equal(requests[0].body.req.method, 'ReportPlayRecentlyInfo')
  assert.deepEqual(requests[0].body.req.param.data, [{
    id: '449205',
    type: 2,
    lastTime: Math.floor(Date.parse('2026-07-28T09:30:00.000Z') / 1000),
    listenCnt: 1,
  }])
})

test('syncQQPlayHistory skips tracks without a numeric QQ songId', async () => {
  let fetchCount = 0
  globalThis.fetch = (async () => {
    fetchCount += 1
    return Response.json({ code: 0, req: { code: 0 } })
  }) as typeof fetch

  const result = await syncQQPlayHistory({
    cookie: 'uin=o123456; qm_keyst=test-key',
    musicInfo: {
      source: 'tx',
      songmid: '003aAYrm3GE0Ac',
      name: '稻香',
      singer: '周杰伦',
      raw: { songType: 0 },
    },
  })

  assert.equal(result.synced, false)
  assert.equal(result.skipped, true)
  assert.equal(result.reason, 'QQ play history sync requires a numeric songId in musicInfo.raw')
  assert.equal(fetchCount, 0)
})

test('syncQQPlayHistory reports failure for a nonzero QQ business code', async () => {
  globalThis.fetch = (async () => Response.json({ code: 0, req: { code: 1001 } })) as typeof fetch

  const result = await syncQQPlayHistory({
    cookie: 'uin=o123456; qm_keyst=test-key',
    musicInfo: {
      source: 'tx',
      songmid: '003aAYrm3GE0Ac',
      name: '稻香',
      singer: '周杰伦',
      raw: { songId: 449205 },
    },
  })

  assert.equal(result.synced, false)
  assert.equal('error' in result ? result.error : '', 'QQ play history report request failed')
})

test('getQQPlayHistory reads the nested QQ recent playback list', async () => {
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    assert.equal(body.req.module, 'music.musicasset.PlayRecentlyRead')
    assert.equal(body.req.method, 'GetPlayRecentlyInfo')
    assert.deepEqual(body.req.param, { type: 2, count: 12 })
    return Response.json({
      code: 0,
      req: {
        code: 0,
        data: {
          type: 2,
          code: 0,
          updateTime: 1785231000,
          data: {
            songList: [{
              track: { id: 102351676, mid: '004XzmRR0gjDUs', title: 'Be with You' },
              lastTime: 1785230999,
              listenCnt: 3,
            }],
          },
        },
      },
    })
  }) as typeof fetch

  const result = await getQQPlayHistory({ cookie: 'uin=o123456; qm_keyst=test-key', limit: 12 })
  assert.equal(result.updateTime, 1785231000)
  assert.equal(result.list.length, 1)
  assert.equal(result.list[0].track?.mid, '004XzmRR0gjDUs')
  assert.equal(result.list[0].listenCnt, 3)
})

test('syncQQPlayHistoryBestEffort is quiet by default when network sync fails', async () => {
  const originalWarn = console.warn
  const originalDebug = console.debug
  const originalDebugEnv = process.env.X_MUSIC_DEBUG_BACKGROUND_SYNC
  const warnings: unknown[] = []
  const debugs: unknown[] = []
  try {
    delete process.env.X_MUSIC_DEBUG_BACKGROUND_SYNC
    console.warn = (...args: unknown[]) => { warnings.push(args) }
    console.debug = (...args: unknown[]) => { debugs.push(args) }
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch

    syncQQPlayHistoryBestEffort({
      cookie: 'uin=o123456; qm_keyst=test-key;',
      musicInfo: {
        source: 'tx',
        songmid: 'quiet-history-song',
        name: 'Quiet History Song',
        singer: 'QQ Artist',
        raw: { songId: 12345 },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(warnings, [])
    assert.deepEqual(debugs, [])
  } finally {
    console.warn = originalWarn
    console.debug = originalDebug
    if (originalDebugEnv === undefined) delete process.env.X_MUSIC_DEBUG_BACKGROUND_SYNC
    else process.env.X_MUSIC_DEBUG_BACKGROUND_SYNC = originalDebugEnv
  }
})

test('pushLocalPlayHistoryToQQ uses event time without resolving a playback URL', async () => {
  const requests: Array<{ url: URL; body?: any }> = []
  const track = ensureTrack({
    source: 'tx',
    songmid: 'push-local-qq-history',
    name: 'Push Local History',
    singer: 'QQ Artist',
    raw: { songId: 123456 },
  })
  insertPlayEvent(track.id, '320k', 'push-history-user', '2026-05-24T11:00:00.000Z')

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init)
    requests.push({
      url: new URL(request.url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return Response.json({ code: 0, req: { code: 0, data: { ret: 0 } } })
  }) as typeof fetch

  const result = await pushLocalPlayHistoryToQQ({
    userId: 'push-history-user',
    cookie: 'uin=o123456; qm_keyst=test-key',
    limit: 1,
  })

  assert.equal(result.synced, 1)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url.origin, 'https://u.y.qq.com')
  assert.equal(requests[0].body.req.param.data[0].id, '123456')
  assert.equal(requests[0].body.req.param.data[0].lastTime, Math.floor(Date.parse('2026-05-24T11:00:00.000Z') / 1000))
})

test('pullQQPlayHistory imports one event per remote song and is idempotent', async () => {
  const playedAt = 1785230999
  globalThis.fetch = (async () => Response.json({
    code: 0,
    req: {
      code: 0,
      data: {
        code: 0,
        data: {
          songList: [{
            track: {
              id: 102351676,
              mid: 'pull-remote-qq-history',
              title: 'Remote History',
              singer: [{ name: 'QQ Artist' }],
            },
            lastTime: playedAt,
            listenCnt: 7,
          }],
        },
      },
    },
  })) as typeof fetch

  const input = { userId: 'pull-history-user', cookie: 'uin=o123456; qm_keyst=test-key', limit: 20 }
  const first = await pullQQPlayHistory(input)
  const second = await pullQQPlayHistory(input)
  const events = listPlayHistory('pull-history-user', 20)

  assert.equal(first.pulled, 1)
  assert.equal(second.pulled, 1)
  assert.equal(events.filter(event => event.songmid === 'pull-remote-qq-history').length, 1)
  assert.equal(events[0].playedAt, new Date(playedAt * 1000).toISOString())
})
