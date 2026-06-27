import assert from 'node:assert/strict'
import test from 'node:test'

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.QQ_MUSIC_COOKIE
})

test('recommendations route separates daily and guess sources', async () => {
  process.env.QQ_MUSIC_COOKIE = 'uin=o123456; qm_keyst=test-key; euin=encrypted-uin'
  const route = await import('@/app/api/recommendations/route')
  const requests: Array<{ url: string; body?: any }> = []

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = String(url)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ url: requestUrl, body })

    if (requestUrl.includes('/soso/fcgi-bin/client_music_search_songlist')) {
      return Response.json({
        code: 0,
        data: {
          list: [{
            dissid: '123456',
            dissname: 'QQ音乐每日30首',
            imgurl: 'https://img.example/daily.jpg',
          }],
        },
      })
    }

    if (requestUrl.includes('/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg')) {
      return Response.json({
        code: 0,
        cdlist: [{
          dissid: '123456',
          dissname: 'QQ音乐每日30首',
          songlist: [{
            mid: 'daily-song',
            title: 'Daily Song',
            singer: [{ name: 'Daily Singer' }],
          }],
        }],
      })
    }

    if (requestUrl.includes('/cgi-bin/musics.fcg')) {
      if (body?.req?.module === 'music.radioProxy.MbTrackRadioSvr') {
        return Response.json({ code: 1, req: { code: 1 } })
      }
      if (body?.req?.module === 'music.srfDissInfo.DissInfo') {
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              songlist: [{
                mid: 'favorite-song',
                title: 'Favorite Song',
                singer: [{ name: 'Favorite Singer' }],
              }],
              total_song_num: 1,
            },
          },
        })
      }
      if (body?.req?.module === 'music.search.SearchCgiService') {
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              body: {
                item_song: [{
                  mid: 'guess-song',
                  title: 'Guess Song',
                  singer: [{ name: 'Guess Singer' }],
                }],
              },
              meta: {
                estimate_sum: 1,
              },
            },
          },
        })
      }
    }

    if (requestUrl.includes('/soso/fcgi-bin/client_search_cp')) {
      return Response.json({
        code: 0,
        data: {
          song: {
            list: [],
            totalnum: 0,
          },
          body: {
            item_song: [{
              mid: 'guess-song',
              title: 'Guess Song',
              singer: [{ name: 'Guess Singer' }],
            }],
          },
          meta: {
            estimate_sum: 1,
          },
        },
      })
    }

    return Response.json({ code: 0, data: { list: [] } })
  }) as typeof fetch

  const daily = await route.GET(new Request('http://local/api/recommendations?type=daily&limit=2'))
  assert.equal(daily.status, 200)
  const dailyPayload = await daily.json()
  assert.equal(dailyPayload.strategy, 'qq-playlist:123456')
  assert.equal(dailyPayload.list[0].songmid, 'daily-song')

  const guess = await route.GET(new Request('http://local/api/recommendations?type=guess&limit=2'))
  assert.equal(guess.status, 200)
  const guessPayload = await guess.json()
  assert.equal(guessPayload.strategy, 'favorite-artist-search')
  assert.equal(guessPayload.list[0].songmid, 'guess-song')

  assert.ok(requests.some(item => item.url.includes('/soso/fcgi-bin/client_music_search_songlist')))
  assert.ok(requests.some(item => item.body?.req?.module === 'music.radioProxy.MbTrackRadioSvr'))
})
