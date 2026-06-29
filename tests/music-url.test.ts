import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { ensureTrack, upsertTrackFileStatus } from '@/lib/cache/store'
import { db } from '@/lib/db'
import { MusicUrlResolveError, parseRequestedQuality, qualityFallbacks, resolveMusicUrl } from '@/lib/music-url/resolve'
import { GET as playGET } from '@/app/api/play/route'
import type { MusicInfo } from '@/lib/types'

const originalFetch = globalThis.fetch
const originalConsoleInfo = console.info
const originalConsoleError = console.error

const song: MusicInfo = {
  source: 'tx',
  songmid: '001TEST',
  name: 'Test Song',
  singer: 'Test Singer',
}

test.afterEach(() => {
  globalThis.fetch = originalFetch
  console.info = originalConsoleInfo
  console.error = originalConsoleError
  delete process.env.LX_MUSIC_SOURCE_SCRIPT
  delete process.env.LX_MUSIC_SOURCE_ORDER
  delete process.env.LX_MUSIC_ID_LOOKUP_ENABLED
  delete process.env.X_MUSIC_MUSIC_URL_LOGS
  db.prepare("DELETE FROM app_settings WHERE key LIKE 'music-url.candidates.%'").run()
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

test('resolveMusicUrl tries platform candidates horizontally before lowering quality', async () => {
  process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://api.example/music/url?key=secret-key'
  process.env.LX_MUSIC_SOURCE_ORDER = 'tx,kw,kg'
  const requests: Array<{ source?: string; musicId?: string; quality?: string }> = []
  const multiSourceSong: MusicInfo = {
    ...song,
    raw: {
      lxSources: [
        { source: 'kw', musicId: 'KW_TEST' },
        { source: 'kg', musicId: 'KG_TEST' },
      ],
    },
  }

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { source?: string; musicId?: string; quality?: string }
    requests.push(body)
    if (body.source === 'kw' && body.quality === 'flac') {
      return Response.json({ code: 200, data: { url: 'https://cdn.example/kw.flac' } })
    }
    return Response.json({ code: 500, message: '未获取到URL' })
  }) as typeof fetch

  try {
    const resolved = await resolveMusicUrl(multiSourceSong, 'flac')
    assert.equal(resolved.url, 'https://cdn.example/kw.flac')
    assert.equal(resolved.upstreamSource, 'kw')
    assert.equal(resolved.upstreamMusicId, 'KW_TEST')
    assert.deepEqual(requests, [
      { source: 'tx', musicId: '001TEST', quality: 'flac' },
      { source: 'kw', musicId: 'KW_TEST', quality: 'flac' },
    ])
  } finally {
    delete process.env.LX_MUSIC_SOURCE_ORDER
  }
})

test('resolveMusicUrlWithFallback lowers quality only after each platform candidate fails', async () => {
  process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://api.example/music/url?key=secret-key'
  process.env.LX_MUSIC_SOURCE_ORDER = 'tx,kw'
  const requests: Array<{ source?: string; musicId?: string; quality?: string }> = []
  const multiSourceSong: MusicInfo = {
    ...song,
    raw: { sourceIds: { kw: 'KW_TEST' } },
  }

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { source?: string; musicId?: string; quality?: string }
    requests.push(body)
    if (body.source === 'tx' && body.quality === '320k') {
      return Response.json({ code: 200, data: { url: 'https://cdn.example/tx-320.mp3' } })
    }
    return Response.json({ code: 500, message: '未获取到URL' })
  }) as typeof fetch

  try {
    const { resolveMusicUrlWithFallback } = await import('@/lib/music-url/resolve')
    const resolved = await resolveMusicUrlWithFallback(multiSourceSong, 'flac')
    assert.equal(resolved.url, 'https://cdn.example/tx-320.mp3')
    assert.deepEqual(requests, [
      { source: 'tx', musicId: '001TEST', quality: 'flac' },
      { source: 'kw', musicId: 'KW_TEST', quality: 'flac' },
      { source: 'tx', musicId: '001TEST', quality: '320k' },
    ])
  } finally {
    delete process.env.LX_MUSIC_SOURCE_ORDER
  }
})

test('resolveMusicUrl resolves and caches cross-platform music ids once', async () => {
  process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://api.example/music/url?key=secret-key'
  process.env.LX_MUSIC_SOURCE_ORDER = 'tx,kw'
  process.env.LX_MUSIC_ID_LOOKUP_ENABLED = 'true'
  const songmid = `CACHE_${Date.now()}`
  const lookupSong: MusicInfo = {
    source: 'tx',
    songmid,
    name: 'Cached Match',
    singer: 'Match Singer',
    albumName: 'Match Album',
    interval: '03:30',
  }
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = new URL(String(url))
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    requests.push({ path: requestUrl.pathname, body })
    if (requestUrl.pathname === '/music/search') {
      return Response.json({
        code: 200,
        data: [
          {
            source: 'kw',
            musicId: 'KW_CACHE_MATCH',
            name: 'Cached Match',
            singer: 'Match Singer',
            albumName: 'Match Album',
            interval: '03:30',
          },
        ],
      })
    }
    if (body.source === 'kw') return Response.json({ code: 200, data: { url: 'https://cdn.example/kw-cache.flac' } })
    return Response.json({ code: 500, message: '未获取到URL' })
  }) as typeof fetch

  try {
    const first = await resolveMusicUrl(lookupSong, 'flac')
    const second = await resolveMusicUrl(lookupSong, '320k')

    assert.equal(first.upstreamSource, 'kw')
    assert.equal(second.upstreamSource, 'kw')
    assert.equal(requests.filter(request => request.path === '/music/search').length, 1)
    assert.deepEqual(
      requests
        .filter(request => request.path === '/music/url')
        .map(request => ({ source: request.body.source, musicId: request.body.musicId, quality: request.body.quality })),
      [
        { source: 'tx', musicId: songmid, quality: 'flac' },
        { source: 'kw', musicId: 'KW_CACHE_MATCH', quality: 'flac' },
        { source: 'tx', musicId: songmid, quality: '320k' },
        { source: 'kw', musicId: 'KW_CACHE_MATCH', quality: '320k' },
      ],
    )
  } finally {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`music-url.candidates.tx.${songmid}`)
    delete process.env.LX_MUSIC_SOURCE_ORDER
    delete process.env.LX_MUSIC_ID_LOOKUP_ENABLED
  }
})

test('resolveMusicUrl caches missing cross-platform lookup to avoid repeated search calls', async () => {
  process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://api.example/music/url?key=secret-key'
  process.env.LX_MUSIC_SOURCE_ORDER = 'tx,kw'
  process.env.LX_MUSIC_ID_LOOKUP_ENABLED = 'true'
  const songmid = `MISS_${Date.now()}`
  const lookupSong: MusicInfo = {
    source: 'tx',
    songmid,
    name: 'Missing Match',
    singer: 'Missing Singer',
    interval: '04:00',
  }
  const requests: string[] = []

  globalThis.fetch = (async (url: string | URL | Request) => {
    const requestUrl = new URL(String(url))
    requests.push(requestUrl.pathname)
    if (requestUrl.pathname === '/music/search') return Response.json({ code: 200, data: [] })
    return Response.json({ code: 500, message: '未获取到URL' })
  }) as typeof fetch

  try {
    await assert.rejects(() => resolveMusicUrl(lookupSong, 'flac'), MusicUrlResolveError)
    await assert.rejects(() => resolveMusicUrl(lookupSong, '320k'), MusicUrlResolveError)

    assert.equal(requests.filter(path => path === '/music/search').length, 1)
    assert.equal(requests.filter(path => path === '/music/url').length, 2)
  } finally {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`music-url.candidates.tx.${songmid}`)
    delete process.env.LX_MUSIC_SOURCE_ORDER
    delete process.env.LX_MUSIC_ID_LOOKUP_ENABLED
  }
})

test('resolveMusicUrl logs every platform url lookup attempt', async () => {
  process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://api.example/music/url?key=secret-key'
  process.env.LX_MUSIC_SOURCE_ORDER = 'tx,kw'
  process.env.X_MUSIC_MUSIC_URL_LOGS = 'true'
  const logs: Array<Record<string, unknown>> = []
  console.info = (message?: unknown) => {
    if (typeof message === 'string') logs.push(JSON.parse(message) as Record<string, unknown>)
  }
  console.error = (message?: unknown) => {
    if (typeof message === 'string') logs.push(JSON.parse(message) as Record<string, unknown>)
  }
  const multiSourceSong: MusicInfo = {
    ...song,
    raw: { sourceIds: { kw: 'KW_LOG_TEST' } },
  }

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { source?: string }
    if (body.source === 'kw') return Response.json({ code: 200, data: { url: 'https://cdn.example/log.flac' } })
    return Response.json({ code: 500, message: '未获取到URL' })
  }) as typeof fetch

  try {
    const resolved = await resolveMusicUrl(multiSourceSong, 'flac')
    assert.equal(resolved.upstreamSource, 'kw')

    const attempts = logs.filter(log => log.event === 'music_url_resolve_attempt')
    assert.deepEqual(attempts.map(log => ({ source: log.source, musicId: log.musicId, found: log.found })), [
      { source: 'tx', musicId: '001TEST', found: false },
      { source: 'kw', musicId: 'KW_LOG_TEST', found: true },
    ])
    assert.ok(logs.some(log => log.event === 'music_url_resolve_candidates'
      && Array.isArray(log.candidates)
      && log.songmid === '001TEST'))
  } finally {
    delete process.env.LX_MUSIC_SOURCE_ORDER
    delete process.env.X_MUSIC_MUSIC_URL_LOGS
  }
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
    (error: unknown) => error instanceof MusicUrlResolveError
      && error.attempts.length === 1
      && error.attempts[0]?.error.includes('未获取到URL'),
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
    const row = db.prepare(`
      SELECT tf.status, tf.error
      FROM track_files tf
      INNER JOIN tracks t ON t.id = tf.track_id
      WHERE t.source = 'tx' AND t.songmid = ? AND tf.quality = '320k'
    `).get(songmid) as { status: string; error: string | null } | undefined
    assert.equal(row?.status, 'failed')
    assert.equal(row?.error, 'Redirected to non-encrypted upstream without local cache')
  } finally {
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
  }
})

test('play API does not use local cache as a playback source', async () => {
  process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://api.example/music/url?key=secret-key'
  const songmid = `LOCAL_CACHE_IGNORED_${Date.now()}`
  const localPath = join(process.cwd(), `data/test-${songmid}.mp3`)
  db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
  mkdirSync(join(process.cwd(), 'data'), { recursive: true })
  writeFileSync(localPath, 'local-cache-bytes')
  const track = ensureTrack({
    source: 'tx',
    songmid,
    name: 'Local Cache Ignored Song',
    singer: 'Local Cache Singer',
  })
  upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: localPath, sizeBytes: 17 })
  const requestedQualities: string[] = []
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { quality?: string }
    requestedQualities.push(body.quality ?? '')
    return Response.json({ code: 200, data: { url: `https://cdn.example/${songmid}.mp3` } })
  }) as typeof fetch

  try {
    const response = await playGET(new Request(`http://local/api/play?${new URLSearchParams({
      source: 'tx',
      songmid,
      name: 'Local Cache Ignored Song',
      singer: 'Local Cache Singer',
      quality: '320k',
    })}`))
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), `https://cdn.example/${songmid}.mp3`)
    assert.equal(response.headers.get('x-x-music-source'), 'upstream')
    assert.deepEqual(requestedQualities, ['320k', 'flac'])
  } finally {
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
    rmSync(localPath, { force: true })
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
