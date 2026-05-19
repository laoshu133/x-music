import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRequestedQuality, qualityFallbacks, resolveMusicUrl } from '@/lib/music-url/resolve'
import type { MusicInfo } from '@/lib/types'

const originalFetch = globalThis.fetch

const song: MusicInfo = {
  source: 'tx',
  songmid: '001TEST',
  name: 'Test Song',
  singer: 'Test Singer',
}

test.afterEach(() => {
  globalThis.fetch = originalFetch
})

test('quality fallback starts from requested quality', () => {
  assert.deepEqual(qualityFallbacks('flac'), ['flac', '320k', '128k'])
  assert.deepEqual(qualityFallbacks('320k'), ['320k', '128k'])
  assert.deepEqual(qualityFallbacks('128k'), ['128k'])
})

test('parseRequestedQuality rejects unsupported values', () => {
  assert.equal(parseRequestedQuality('flac'), 'flac')
  assert.equal(parseRequestedQuality('hires'), undefined)
  assert.equal(parseRequestedQuality(null), undefined)
})

test('resolveMusicUrl parses LX script API config and calls music URL API', async () => {
  process.env.LX_MUSIC_URL_SCRIPT = 'https://script.example/lx?key=fallback-key'
  const requests: Array<{ url: string; init?: RequestInit }> = []

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = String(url)
    requests.push({ url: requestUrl, init })
    if (requestUrl.startsWith('https://script.example/')) {
      return new Response('const API_URL = "https://api.example"; const API_KEY = "secret-key";')
    }
    return Response.json({ code: 200, url: 'https://cdn.example/test.flac' })
  }) as typeof fetch

  const resolved = await resolveMusicUrl(song, 'flac')
  assert.equal(resolved.url, 'https://cdn.example/test.flac')
  assert.equal(requests[1].url, 'https://api.example/music/url')
  assert.equal((requests[1].init?.headers as Record<string, string>)['x-api-key'], 'secret-key')
  assert.equal(requests[1].init?.body, JSON.stringify({ source: 'tx', musicId: '001TEST', quality: 'flac' }))
})
