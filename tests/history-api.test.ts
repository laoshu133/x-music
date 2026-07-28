import assert from 'node:assert/strict'
import test from 'node:test'
import { GET } from '@/app/api/history/route'
import { db } from '@/lib/db'
import { clearQQLoginCookie, saveQQLoginCookie } from '@/lib/db/qq-session'

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
  clearQQLoginCookie()
  db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run('history-api-qq-song')
})

test('history API pulls QQ recent playback into the current user history', async () => {
  saveQQLoginCookie('uin=o700002; qm_keyst=test-key')
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    assert.equal(body.req.module, 'music.musicasset.PlayRecentlyRead')
    return Response.json({
      code: 0,
      req: {
        code: 0,
        data: {
          code: 0,
          data: {
            songList: [{
              track: {
                id: 70000201,
                mid: 'history-api-qq-song',
                title: 'History API QQ Song',
                singer: [{ name: 'QQ Artist' }],
              },
              lastTime: 1785230999,
              listenCnt: 4,
            }],
          },
        },
      },
    })
  }) as typeof fetch

  const response = await GET(new Request('http://local/api/history?sync=pull&remote=qq&limit=10'))
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.source, 'qq')
  assert.equal(payload.pulled, 1)
  assert.equal(payload.skipped, 0)
  assert.equal(payload.list[0].songmid, 'history-api-qq-song')
  assert.equal(payload.list[0].playedAt, new Date(1785230999 * 1000).toISOString())
})
