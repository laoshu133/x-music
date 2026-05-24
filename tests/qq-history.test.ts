import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureTrack, insertPlayEvent } from '@/lib/cache/store'
import { db } from '@/lib/db'
import { setSetting, deleteSetting } from '@/lib/db/settings'
import { syncQQPlayHistory, syncQQPlayHistoryBestEffort } from '@/lib/qq/history'
import { pushLocalPlayHistoryToQQ } from '@/lib/qq/history-sync'

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
  deleteSetting('qq.musicUrlApi')
  db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run('push-local-qq-history')
  delete process.env.QQ_MUSIC_COOKIE
})

test('syncQQPlayHistory reports simulated player playback through QQ sdk webcomm', async () => {
  const requests: Array<{ url: URL; method: string; headers: Headers; body: any }> = []

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init)
    requests.push({
      url: new URL(request.url),
      method: request.method,
      headers: request.headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return new Response('', { status: 200 })
  }) as typeof fetch

  const playUrl = 'https://ws6.stream.qqmusic.qq.com/O400000v8zz72pl692.ogg?guid=4438435184&vkey=test&uin=123456'
  const result = await syncQQPlayHistory({
    cookie: 'uin=o123456; login_type=1; qm_keyst=test-key; euin=encrypted-uin',
    quality: 'flac',
    playUrl,
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
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].url.href, 'https://stat6.y.qq.com/sdk/fcgi-bin/sdk.fcg')
  assert.equal(requests[0].headers.get('content-type'), 'text/plain;charset=UTF-8')
  assert.equal(requests[0].headers.get('cookie'), 'uin=o123456; login_type=1; qm_keyst=test-key; euin=encrypted-uin')

  assert.equal(requests[0].body.common._appid, 'qqmusic')
  assert.equal(requests[0].body.common._uid, 123456)
  assert.equal(requests[0].body.common._platform, 11)
  assert.equal(requests[0].body.common._account_source, '1')
  assert.equal(requests[0].body.common._os, 'mac')
  assert.equal(requests[0].body.common._app, 'mac')

  const item = requests[0].body.items[0]
  assert.equal(item._key, 'webcomm')
  assert.equal(item.cmd, '25')
  assert.equal(item.int1, 3)
  assert.equal(item.str1, '123456')
  assert.equal(item.int2, 449205)
  assert.equal(item.str2, 'PC')
  assert.equal(item.int3, 0)
  assert.equal(item.str3, 'other')
  assert.equal(item.str9, playUrl)
  assert.equal(item.str10, 'https://y.qq.com/n/ryqq_v2/player')
})

test('syncQQPlayHistory skips sdk playback report when upstream play URL is unavailable', async () => {
  let fetchCount = 0
  globalThis.fetch = (async () => {
    fetchCount += 1
    return new Response('', { status: 200 })
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

  assert.equal(result.synced, false)
  assert.equal(result.skipped, true)
  assert.equal(result.reason, 'QQ play history sync requires an upstream play URL')
  assert.equal(fetchCount, 0)
})

test('syncQQPlayHistory reports failure when sdk playback report is rejected', async () => {
  globalThis.fetch = (async () => Response.json({ code: 1 }, { status: 502 })) as typeof fetch

  const result = await syncQQPlayHistory({
    cookie: 'uin=o123456; qm_keyst=test-key; euin=encrypted-uin',
    quality: 'flac',
    playUrl: 'https://ws6.stream.qqmusic.qq.com/test.ogg',
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

  assert.equal(result.synced, false)
  assert.equal('error' in result ? result.error : '', 'QQ play history sdk report request failed')
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
      quality: '320k',
      playUrl: 'https://cdn.example/song.mp3',
      musicInfo: {
        source: 'tx',
        songmid: 'quiet-history-song',
        name: 'Quiet History Song',
        singer: 'QQ Artist',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(warnings, [])
    assert.deepEqual(debugs, [])
  } finally {
    console.warn = originalWarn
    console.debug = originalDebug
    if (originalDebugEnv === undefined) {
      delete process.env.X_MUSIC_DEBUG_BACKGROUND_SYNC
    } else {
      process.env.X_MUSIC_DEBUG_BACKGROUND_SYNC = originalDebugEnv
    }
  }
})

test('pushLocalPlayHistoryToQQ reports local playback events through QQ sdk', async () => {
  const requests: Array<{ url: URL; method: string; body?: any }> = []
  const musicInfo = {
    source: 'tx' as const,
    songmid: 'push-local-qq-history',
    name: 'Push Local History',
    singer: 'QQ Artist',
    raw: { songId: 123456, songType: 0 },
  }
  setSetting('qq.musicUrlApi', {
    url: 'https://resolver.example/music/url',
    key: 'test-key',
  })
  const track = ensureTrack(musicInfo)
  insertPlayEvent(track.id, '320k', '123456', '2026-05-24T11:00:00.000Z')

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init)
    requests.push({
      url: new URL(request.url),
      method: request.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    if (request.url.startsWith('https://resolver.example/music/url')) {
      return Response.json({
        url: 'https://ws6.stream.qqmusic.qq.com/local-history.mp3?vkey=test',
        quality: '320k',
      })
    }
    return new Response('', { status: 200 })
  }) as typeof fetch

  const result = await pushLocalPlayHistoryToQQ({
    cookie: 'uin=o123456; qm_keyst=test-key',
    limit: 1,
  })

  assert.equal(result.synced, 1)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url.href, 'https://resolver.example/music/url')
  assert.equal(requests[1].url.href, 'https://stat6.y.qq.com/sdk/fcgi-bin/sdk.fcg')
  assert.equal(requests[1].body.items[0].int2, 123456)
})
