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
  db.prepare("DELETE FROM resource_cache WHERE source = 'lx'").run()
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

test('resolveMusicUrl parses legacy LX script API constants and calls music URL API', async () => {
  process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/legacy-lx?key=fallback-key'
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

test('resolveMusicUrl simulates LX request event scripts and reuses captured request shape', async () => {
  process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/event-lx'
  const requests: Array<{ url: string; init?: RequestInit }> = []

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = String(url)
    requests.push({ url: requestUrl, init })
    if (requestUrl === 'https://script.example/event-lx') {
      return new Response(`
        globalThis.lx.on(globalThis.lx.EVENT_NAMES.request, ({ source, action, info }) => {
          if (source !== 'tx' || action !== 'musicUrl') return
          globalThis.lx.request('https://api.example/custom/music/url', {
            method: 'PUT',
            headers: {
              'content-type': 'application/json',
              authorization: 'Bearer captured-key'
            },
            body: JSON.stringify({
              source: '__X_MUSIC_SOURCE__',
              id: info.musicInfo.songmid,
              quality: info.type
            })
          }, () => {})
        })
      `)
    }
    return Response.json({ code: 200, data: { musicUrl: 'https://cdn.example/event.flac' } })
  }) as typeof fetch

  const resolved = await resolveMusicUrl(song, '320k')
  assert.equal(resolved.url, 'https://cdn.example/event.flac')
  assert.equal(requests[1].url, 'https://api.example/custom/music/url')
  assert.equal(requests[1].init?.method, 'PUT')
  assert.equal((requests[1].init?.headers as Record<string, string>).authorization, 'Bearer captured-key')
  assert.equal(requests[1].init?.body, JSON.stringify({ source: 'tx', id: '001TEST', quality: '320k' }))
})

test('resolveMusicUrl ignores startup LX requests and captures musicUrl request shape', async () => {
  process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/startup-request-lx'
  const requests: Array<{ url: string; init?: RequestInit }> = []

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = String(url)
    requests.push({ url: requestUrl, init })
    if (requestUrl === 'https://script.example/startup-request-lx') {
      return new Response(`
        const API_URL = 'https://api.example'
        const API_KEY = 'secret-key'
        const { EVENT_NAMES, request, on } = globalThis.lx
        const httpFetch = (url, options) => new Promise((resolve, reject) => {
          request(url, options, (err, resp) => err ? reject(err) : resolve(resp))
        })
        const checkUpdate = async () => {
          await httpFetch(API_URL + '/script/lxmusic?checkUpdate=abc&key=' + API_KEY, {
            method: 'GET',
            headers: { 'content-type': 'application/json' }
          })
        }
        on(EVENT_NAMES.request, ({ source, action, info }) => {
          if (action !== 'musicUrl') return
          return httpFetch(API_URL + '/music/url', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': API_KEY
            },
            body: {
              source,
              musicId: info.musicInfo.songmid,
              quality: info.type
            }
          })
        })
        checkUpdate()
      `)
    }
    return Response.json({ code: 200, url: 'https://cdn.example/startup.flac' })
  }) as typeof fetch

  const resolved = await resolveMusicUrl(song, 'flac')
  assert.equal(resolved.url, 'https://cdn.example/startup.flac')
  assert.equal(requests[1].url, 'https://api.example/music/url')
  assert.equal(requests[1].init?.method, 'POST')
  assert.equal((requests[1].init?.headers as Record<string, string>)['x-api-key'], 'secret-key')
  assert.equal(requests[1].init?.body, JSON.stringify({ source: 'tx', musicId: '001TEST', quality: 'flac' }))
})

test('resolveMusicUrl refreshes invalid cached LX script text', async () => {
  process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/refresh-lx'
  const requests: Array<{ url: string; init?: RequestInit }> = []
  let scriptFetches = 0

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = String(url)
    requests.push({ url: requestUrl, init })
    if (requestUrl === 'https://script.example/refresh-lx') {
      scriptFetches += 1
      if (scriptFetches === 1) return new Response('https://cdn.example/stale.mp3')
      return new Response(`
        const API_URL = 'https://api.example'
        const API_KEY = 'secret-key'
      `)
    }
    return Response.json({ code: 200, url: 'https://cdn.example/refreshed.flac' })
  }) as typeof fetch

  const resolved = await resolveMusicUrl(song, 'flac')
  assert.equal(resolved.url, 'https://cdn.example/refreshed.flac')
  assert.equal(scriptFetches, 2)
  assert.equal(requests[2].url, 'https://api.example/music/url')
})

test('resolveMusicUrl does not let LX source scripts reach Node process through sandbox functions', async () => {
  process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/sandboxed'
  const requests: Array<{ url: string; init?: RequestInit }> = []

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = String(url)
    requests.push({ url: requestUrl, init })
    if (requestUrl === 'https://script.example/sandboxed') {
      return new Response(`
        let leaked
        try {
          leaked = globalThis.lx.on.constructor('return typeof process')()
        } catch {
          leaked = 'blocked'
        }
        globalThis.lx.on(globalThis.lx.EVENT_NAMES.request, () => {
          globalThis.lx.request('https://api.example/sandboxed', {
            method: 'POST',
            headers: { 'x-leak-check': leaked },
            body: JSON.stringify({ musicId: '__X_MUSIC_MUSIC_ID__' })
          })
        })
      `)
    }
    return Response.json({ url: 'https://cdn.example/sandboxed.mp3' })
  }) as typeof fetch

  const resolved = await resolveMusicUrl(song, '128k')
  assert.equal(resolved.url, 'https://cdn.example/sandboxed.mp3')
  assert.equal(requests[1].url, 'https://api.example/sandboxed')
  assert.equal((requests[1].init?.headers as Record<string, string>)['x-leak-check'], 'blocked')
})
