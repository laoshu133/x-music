import assert from 'node:assert/strict'
import test from 'node:test'
import { db } from '@/lib/db'
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
  delete process.env.LX_MUSIC_SOURCE_SCRIPT
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

test('resolveMusicUrl calls the LX music URL API and preserves ekey', async () => {
  process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://api.example/script/lxmusic?key=secret-key'
  const requests: Array<{ url: string; init?: RequestInit }> = []

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = String(url)
    requests.push({ url: requestUrl, init })
    return Response.json({ code: 200, data: { url: 'https://cdn.example/test.flac', ekey: 'test-ekey' } })
  }) as typeof fetch

  const resolved = await resolveMusicUrl(song, 'flac')
  assert.equal(resolved.url, 'https://cdn.example/test.flac')
  assert.equal(resolved.ekey, 'test-ekey')
  assert.equal(requests[0].url, 'https://api.example/music/url')
  assert.equal(requests[0].init?.method, 'POST')
  assert.equal((requests[0].init?.headers as Record<string, string>)['x-api-key'], 'secret-key')
  assert.equal(requests[0].init?.body, JSON.stringify({ source: 'tx', musicId: '001TEST', quality: 'flac' }))
})

test('resolveMusicUrl accepts a direct /music/url API setting', async () => {
  process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://api.example/music/url?key=secret-key'
  const requests: Array<{ url: string; init?: RequestInit }> = []

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = String(url)
    requests.push({ url: requestUrl, init })
    return Response.json({ code: 200, data: { musicUrl: 'https://cdn.example/direct.mp3' } })
  }) as typeof fetch

  const resolved = await resolveMusicUrl(song, '320k')
  assert.equal(resolved.url, 'https://cdn.example/direct.mp3')
  assert.equal(requests[0].url, 'https://api.example/music/url')
  assert.equal(requests[0].init?.body, JSON.stringify({ source: 'tx', musicId: '001TEST', quality: '320k' }))
})

test('resolveMusicUrl requires key for the LX music URL API', async () => {
  process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://api.example/music/url'
  await assert.rejects(resolveMusicUrl(song, '128k'), /must include key or apiKey/)
})
