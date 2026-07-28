import assert from 'node:assert/strict'
import test from 'node:test'
import { clearQQLoginCookie, saveQQLoginCookie } from '@/lib/db/qq-session'
import { getQQRecommendations } from '@/lib/qq/recommendations'

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.QQ_MUSIC_COOKIE
  delete process.env.QQ_RECOMMENDATION_BATCH_TIMEOUT_MS
  delete process.env.QQ_RECOMMENDATION_TOTAL_TIMEOUT_MS
  delete process.env.QQ_RECOMMENDATION_SLOW_LOG_MS
  clearQQLoginCookie()
})

test('recommendations route uses authenticated QQ daily feed and radio sources', async () => {
  saveQQLoginCookie('uin=o123456; qm_keyst=test-key; euin=encrypted-uin')
  const route = await import('@/app/api/recommendations/route')
  const requests: Array<{ url: string; headers: Headers; body?: any }> = []

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ url: request.url, headers: request.headers, body })

    if (body?.req?.module === 'music.recommend.RecommendFeed') {
      return Response.json({
        code: 0,
        req: {
          code: 0,
          data: {
            v_shelf: [{
              v_niche: [{
                v_card: [
                  { id: '111', title: '私人雷达' },
                  { id: '7804423650', title: '每日30首' },
                ],
              }],
            }],
          },
        },
      })
    }

    if (body?.req?.module === 'music.srfDissInfo.DissInfo') {
      return Response.json({
        code: 0,
        req: {
          code: 0,
          data: {
            songlist: [{
              id: 1001,
              mid: 'daily-song',
              title: 'Daily Song',
              singer: [{ name: 'Daily Singer' }],
            }],
          },
        },
      })
    }

    if (body?.req?.module === 'music.radioProxy.MbTrackRadioSvr') {
      return Response.json({
        code: 0,
        req: {
          code: 0,
          data: {
            tracks: Array.from({ length: 5 }, (_, index) => ({
              id: 1002 + index,
              mid: `guess-song-${index}`,
              title: `Guess Song ${index}`,
              singer: [{ name: 'Guess Singer' }],
            })),
          },
        },
      })
    }

    return Response.json({ code: 1, req: { code: 1 } })
  }) as typeof fetch

  const daily = await route.GET(new Request('http://local/api/recommendations?type=daily&limit=2'))
  assert.equal(daily.status, 200)
  const dailyPayload = await daily.json()
  assert.equal(dailyPayload.strategy, 'qq-daily:7804423650')
  assert.equal(dailyPayload.personalized, true)
  assert.equal(dailyPayload.list[0].songmid, 'daily-song')

  const guess = await route.GET(new Request('http://local/api/recommendations?type=guess&limit=2'))
  assert.equal(guess.status, 200)
  const guessPayload = await guess.json()
  assert.equal(guessPayload.strategy, 'qq-radio:99')
  assert.equal(guessPayload.personalized, true)
  assert.equal(guessPayload.list.length, 2)
  assert.equal(guessPayload.list[0].songmid, 'guess-song-0')

  assert.equal(requests.length, 3)
  assert.ok(requests.every(item => item.url.includes('/cgi-bin/musics.fcg?sign=')))
  assert.ok(requests.every(item => item.headers.get('cookie')?.includes('uin=o123456')))
  const detail = requests.find(item => item.body?.req?.module === 'music.srfDissInfo.DissInfo')
  assert.equal(detail?.body.req.method, 'CgiGetDiss')
  assert.equal(detail?.body.req.param.disstid, 7804423650)
  assert.equal(requests.some(item => item.url.includes('client_music_search_songlist')), false)
})

test('QQ guess recommendations dynamically aggregate fixed five-song batches', async () => {
  const batchSizes: number[] = []
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    const batch = batchSizes.length
    batchSizes.push(body.req.param.num)
    return Response.json({
      code: 0,
      req: {
        code: 0,
        data: {
          tracks: Array.from({ length: 5 }, (_, index) => {
            const id = batch * 5 + index
            return {
              id: 2000 + id,
              mid: `dynamic-guess-${id}`,
              title: `Dynamic Guess ${id}`,
              singer: [{ name: 'Guess Singer' }],
            }
          }),
        },
      },
    })
  }) as typeof fetch

  const result = await getQQRecommendations({
    cookie: 'uin=o123458; qm_keyst=test-key',
    limit: 12,
  })

  assert.equal(result.list.length, 12)
  assert.equal(result.total, 12)
  assert.deepEqual(batchSizes, [5, 5, 5])
  assert.equal(new Set(result.list.map(song => song.songmid)).size, 12)
})

test('recommendations route caps each guess page at 30 songs', async () => {
  saveQQLoginCookie('uin=o123462; qm_keyst=test-key')
  const route = await import('@/app/api/recommendations/route')
  let requests = 0
  globalThis.fetch = (async () => {
    const batch = requests
    requests += 1
    return Response.json({
      code: 0,
      req: {
        code: 0,
        data: {
          tracks: Array.from({ length: 5 }, (_, index) => {
            const id = batch * 5 + index
            return {
              id: 2500 + id,
              mid: `capped-guess-${id}`,
              title: `Capped Guess ${id}`,
            }
          }),
        },
      },
    })
  }) as typeof fetch

  const response = await route.GET(new Request('http://local/api/recommendations?type=guess&limit=100'))
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.list.length, 30)
  assert.equal(requests, 6)
})

test('QQ guess recommendations stop when a batch contains no new songs', async () => {
  let requests = 0
  globalThis.fetch = (async () => {
    requests += 1
    return Response.json({
      code: 0,
      req: {
        code: 0,
        data: {
          tracks: Array.from({ length: 5 }, (_, index) => ({
            id: 3000 + index,
            mid: `repeated-guess-${index}`,
            title: `Repeated Guess ${index}`,
          })),
        },
      },
    })
  }) as typeof fetch

  const result = await getQQRecommendations({
    cookie: 'uin=o123459; qm_keyst=test-key',
    limit: 30,
  })

  assert.equal(requests, 2)
  assert.equal(result.list.length, 5)
})

test('QQ guess recommendations return collected songs when a later batch times out', async () => {
  process.env.QQ_RECOMMENDATION_BATCH_TIMEOUT_MS = '10'
  process.env.QQ_RECOMMENDATION_TOTAL_TIMEOUT_MS = '100'
  let requests = 0
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests += 1
    if (requests === 1) {
      return Response.json({
        code: 0,
        req: {
          code: 0,
          data: {
            tracks: Array.from({ length: 5 }, (_, index) => ({
              id: 4000 + index,
              mid: `partial-guess-${index}`,
              title: `Partial Guess ${index}`,
            })),
          },
        },
      })
    }

    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      const abort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    })
  }) as typeof fetch

  const result = await getQQRecommendations({
    cookie: 'uin=o123460; qm_keyst=test-key',
    limit: 10,
  })

  assert.equal(requests, 2)
  assert.equal(result.list.length, 5)
})

test('QQ guess recommendations fail with 504 when the first batch times out', async () => {
  process.env.QQ_RECOMMENDATION_BATCH_TIMEOUT_MS = '10'
  process.env.QQ_RECOMMENDATION_TOTAL_TIMEOUT_MS = '100'
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      const abort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    })
  }) as typeof fetch

  await assert.rejects(
    getQQRecommendations({
      cookie: 'uin=o123461; qm_keyst=test-key',
      limit: 10,
    }),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 504)
      assert.equal((error as { payload?: { code?: string } }).payload?.code, 'QQ_RECOMMENDATIONS_TIMEOUT')
      return true
    },
  )
})

test('recommendations route does not replace a failed personalized response with public content', async () => {
  saveQQLoginCookie('uin=o123457; qm_keyst=test-key')
  const route = await import('@/app/api/recommendations/route')
  const requests: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    requests.push(String(url))
    return Response.json({ code: 0, req: { code: 0, data: { tracks: [] } } })
  }) as typeof fetch

  const response = await route.GET(new Request('http://local/api/recommendations?type=guess'))
  assert.equal(response.status, 502)
  assert.equal(requests.length, 1)
  assert.ok(requests[0].includes('/cgi-bin/musics.fcg?sign='))
})
