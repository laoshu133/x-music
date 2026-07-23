import assert from 'node:assert/strict'
import test from 'node:test'
import { GET } from '@/app/api/history/route'
import { clearQQLoginCookie, saveQQLoginCookie } from '@/lib/db/qq-session'

test('history API does not implement QQ play history pull', async () => {
  saveQQLoginCookie('uin=o700002; qm_keyst=test-key')
  const response = await GET(new Request('http://local/api/history?sync=pull&remote=qq&limit=1'))
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.source, 'local')
  assert.ok(Array.isArray(payload.list))
  clearQQLoginCookie()
})
