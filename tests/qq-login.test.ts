import assert from 'node:assert/strict'
import test from 'node:test'
import { checkQQLoginQr } from '@/lib/qq/user'

const qrInput = { ptqrtoken: 123456, qrsig: 'test-qrsig' }

test('QQ QR polling retries a transient network failure', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  try {
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 1) {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
        })
      }
      return new Response("ptuiCB('67','0','','0','认证中','')")
    }) as typeof fetch

    const result = await checkQQLoginQr(qrInput)

    assert.equal(calls, 2)
    assert.equal(result.isOk, false)
    assert.equal(result.isOk ? undefined : result.status, 'scanned')
    assert.equal(result.isOk ? undefined : result.transient, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('QQ QR polling returns a recoverable state after repeated network failures', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  try {
    globalThis.fetch = (async () => {
      calls += 1
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('temporary DNS failure'), { code: 'EAI_AGAIN' }),
      })
    }) as typeof fetch

    const result = await checkQQLoginQr(qrInput)

    assert.equal(calls, 3)
    assert.equal(result.isOk, false)
    assert.equal(result.isOk ? undefined : result.status, 'pending')
    assert.equal(result.isOk ? undefined : result.transient, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})
