import assert from 'node:assert/strict'
import test from 'node:test'
import { db } from '@/lib/db'
import { MusicUrlUnavailableError, parseRequestedQuality, qualityFallbacks, resolveMusicUrl } from '@/lib/music-url/resolve'
import { GET as playGET } from '@/app/api/play/route'
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

test('resolveMusicUrl treats missing LX URL responses as unavailable music', async () => {
  process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://api.example/music/url?key=secret-key'
  globalThis.fetch = (async () => Response.json({ code: 500, message: '未获取到URL' })) as typeof fetch

  await assert.rejects(
    () => resolveMusicUrl(song, '128k'),
    (error: unknown) => error instanceof MusicUrlUnavailableError
      && error.reason === '未获取到URL',
  )
})

test('play API redirects non-encrypted LX CDN URLs instead of proxying first playback', async () => {
  process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://api.example/music/url?key=secret-key'
  const songmid = `REDIRECT_${Date.now()}`
  db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
  globalThis.fetch = (async () => {
    return Response.json({ code: 200, data: { url: `https://cdn.example/${songmid}.mp3` } })
  }) as typeof fetch

  try {
    const response = await playGET(new Request(`http://local/api/play?${new URLSearchParams({
      source: 'tx',
      songmid,
      name: 'Redirect Song',
      singer: 'Redirect Singer',
      quality: '320k',
    })}`))
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), `https://cdn.example/${songmid}.mp3`)
    assert.equal(response.headers.get('x-x-music-stream-mode'), 'redirect')
  } finally {
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
  }
})

test('play API returns 451 when LX source cannot provide a playable URL', async () => {
  process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://api.example/music/url?key=secret-key'
  const songmid = `UNAVAILABLE_${Date.now()}`
  db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
  globalThis.fetch = (async () => Response.json({ code: 500, message: '未获取到URL' })) as typeof fetch

  try {
    const response = await playGET(new Request(`http://local/api/play?${new URLSearchParams({
      source: 'tx',
      songmid,
      name: 'Unavailable Song',
      singer: 'Unavailable Singer',
      quality: '128k',
    })}`))
    assert.equal(response.status, 451)
    const payload = await response.json()
    assert.match(payload.error, /未获取到URL/)
  } finally {
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
  }
})
