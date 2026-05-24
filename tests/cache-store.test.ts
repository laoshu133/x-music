import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { ensureTrack, getPlayableTrackFile, getReadyTrackFile, insertPlayEvent, listPlayHistory, upsertTrackFileStatus } from '@/lib/cache/store'
import { cachedResourceResponse, cleanupResourceCache, getCachedTextResource } from '@/lib/cache/resources'
import { createUpstreamTeeResponse } from '@/lib/cache/stream'
import { refreshUmCrypto, resolveUmCryptoLoaderPath } from '@/lib/cache/um-crypto'
import { appConfig } from '@/lib/config'
import { db } from '@/lib/db'
import type { MusicInfo } from '@/lib/types'

test('cache store returns only ready files that exist on disk', () => {
  const songmid = `CACHE_${Date.now()}`
  const musicInfo: MusicInfo = {
    source: 'tx',
    songmid,
    name: 'Cache Test',
    singer: 'Tester',
  }

  const track = ensureTrack(musicInfo)
  upsertTrackFileStatus(track.id, 'flac', 'ready', { finalPath: `/tmp/x-music-missing-${songmid}.flac` })
  assert.equal(getReadyTrackFile('tx', songmid, 'flac'), undefined)

  upsertTrackFileStatus(track.id, 'flac', 'failed', { error: 'upstream failed' })
  const failedReadyFile = getReadyTrackFile('tx', songmid, 'flac')
  assert.equal(failedReadyFile, undefined)
})

test('cache store can serve cached raw files before tagging finishes', () => {
  const songmid = `PLAYABLE_${Date.now()}`
  const rawPath = `/tmp/x-music-playable-${songmid}.mp3`
  fs.writeFileSync(rawPath, 'fake audio')
  try {
    const musicInfo: MusicInfo = {
      source: 'tx',
      songmid,
      name: 'Playable Test',
      singer: 'Tester',
    }

    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, '320k', 'tagging', { rawPath, finalPath: rawPath })

    const file = getPlayableTrackFile('tx', songmid, '320k')
    assert.equal(file?.rawPath, rawPath)
    assert.equal(file?.finalPath, rawPath)
  } finally {
    fs.unlinkSync(rawPath)
  }
})

test('cache store does not serve encrypted QQ cache files as playable audio', () => {
  const songmid = `ENCRYPTED_PLAYABLE_${Date.now()}`
  const finalPath = `/tmp/x-music-encrypted-${songmid}.mgg`
  fs.writeFileSync(finalPath, 'fake encrypted audio')
  try {
    const musicInfo: MusicInfo = {
      source: 'tx',
      songmid,
      name: 'Encrypted Playable Test',
      singer: 'Tester',
    }

    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath })

    assert.equal(getReadyTrackFile('tx', songmid, '320k'), undefined)
    assert.equal(getPlayableTrackFile('tx', songmid, '320k'), undefined)
  } finally {
    fs.unlinkSync(finalPath)
  }
})

test('upstream stream passes through encrypted-extension upstreams without LX ekey', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `ENCRYPTED_STREAM_${Date.now()}`
  const musicInfo: MusicInfo = {
    source: 'tx',
    songmid,
    name: 'Encrypted Stream Test',
    singer: 'Tester',
  }

  try {
    const track = ensureTrack(musicInfo)
    globalThis.fetch = (async () => {
      return new Response('ID3 fake audio bytes', {
        headers: { 'content-type': 'application/octet-stream' },
      })
    }) as typeof fetch

    const { response, completion } = await createUpstreamTeeResponse(
      `https://ws.stream.qqmusic.qq.com/${songmid}.mgg?vkey=test`,
      track,
      '320k',
      new Request('http://local/play'),
    )
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'audio/mpeg')
    assert.equal(await response.text(), 'ID3 fake audio bytes')
    await completion

    const file = getPlayableTrackFile('tx', songmid, '320k')
    assert.ok(file?.finalPath?.endsWith('.mp3'))
    assert.ok(file?.finalPath)
    assert.equal(fs.readFileSync(file.finalPath, 'utf8'), 'ID3 fake audio bytes')
  } finally {
    globalThis.fetch = originalFetch
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)
  }
})

test('upstream stream decrypts encrypted QQ audio containers through UM crypto while caching', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `DECRYPTED_STREAM_${Date.now()}`
  const version = `99.0.${Date.now()}`
  const toolDir = path.join(appConfig.toolsDir, 'um-crypto', version)
  const archivePath = `/tmp/x-music-um-crypto-${version}.tgz`
  const fixtureDir = `/tmp/x-music-um-crypto-fixture-${version}`
  const musicInfo: MusicInfo = {
    source: 'tx',
    songmid,
    name: 'Decrypted Stream Test',
    singer: 'Tester',
  }

  try {
    const archive = await createUmCryptoPackage({
      fixtureDir,
      archivePath,
      loader: fakeUmCryptoLoader({ replacementText: 'decrypted audio bytes' }),
    })
    fs.rmSync(toolDir, { recursive: true, force: true })
    const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`
    const tarballUrl = `https://release.example/crypto-${version}.tgz`

    const track = ensureTrack(musicInfo)
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url)
      if (requestUrl.includes('/api/packages/um/npm/%40unlock-music%2Fcrypto')) {
        return Response.json({
          'dist-tags': { latest: version },
          versions: { [version]: { dist: { integrity, tarball: tarballUrl } } },
        })
      }
      if (requestUrl === tarballUrl) return new Response(new Uint8Array(archive))
      return new Response('encrypted audio bytes', { headers: { 'content-type': 'application/octet-stream' } })
    }) as typeof fetch

    await refreshUmCrypto()
    const { response, completion } = await createUpstreamTeeResponse(
      `https://ws.stream.qqmusic.qq.com/${songmid}.mgg?vkey=test`,
      track,
      '320k',
      new Request('http://local/play'),
      'lx-ekey',
    )
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'decrypted audio bytes')
    await completion

    const file = getPlayableTrackFile('tx', songmid, '320k')
    assert.match(file?.finalPath ?? '', /\.mp3$/)
    assert.equal(fs.existsSync(file?.finalPath ?? ''), true)
  } finally {
    fs.rmSync(toolDir, { recursive: true, force: true })
    fs.rmSync(fixtureDir, { recursive: true, force: true })
    fs.rmSync(archivePath, { force: true })
    globalThis.fetch = originalFetch
  }
})

test('upstream stream passes LX ekey into UM crypto QMC2 decryptor', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `EKEY_STREAM_${Date.now()}`
  const version = `99.0.${Date.now()}`
  const toolDir = path.join(appConfig.toolsDir, 'um-crypto', version)
  const archivePath = `/tmp/x-music-um-crypto-${version}.tgz`
  const fixtureDir = `/tmp/x-music-um-crypto-fixture-${version}`
  const musicInfo: MusicInfo = {
    source: 'tx',
    songmid,
    name: 'EKey Stream Test',
    singer: 'Tester',
  }

  try {
    const archive = await createUmCryptoPackage({
      fixtureDir,
      archivePath,
      loader: fakeUmCryptoLoader({ requiredEkey: 'lx-ekey', replacementText: 'decrypted audio bytes' }),
    })
    fs.rmSync(toolDir, { recursive: true, force: true })
    const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`
    const tarballUrl = `https://release.example/crypto-${version}.tgz`

    const track = ensureTrack(musicInfo)
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url)
      if (requestUrl.includes('/api/packages/um/npm/%40unlock-music%2Fcrypto')) {
        return Response.json({
          'dist-tags': { latest: version },
          versions: { [version]: { dist: { integrity, tarball: tarballUrl } } },
        })
      }
      if (requestUrl === tarballUrl) return new Response(new Uint8Array(archive))
      return new Response('encrypted audio bytes', {
        headers: { 'content-type': 'application/octet-stream' },
      })
    }) as typeof fetch

    await refreshUmCrypto()
    const { response, completion } = await createUpstreamTeeResponse(
      `https://ws.stream.qqmusic.qq.com/${songmid}.mgg?vkey=test`,
      track,
      '320k',
      new Request('http://local/play'),
      'lx-ekey',
    )
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'decrypted audio bytes')
    await completion

    const file = getPlayableTrackFile('tx', songmid, '320k')
    assert.match(file?.finalPath ?? '', /\.mp3$/)
  } finally {
    fs.rmSync(toolDir, { recursive: true, force: true })
    fs.rmSync(fixtureDir, { recursive: true, force: true })
    fs.rmSync(archivePath, { force: true })
    globalThis.fetch = originalFetch
  }
})

test('UM crypto resolver downloads and reuses latest package asset', async () => {
  const originalFetch = globalThis.fetch
  const version = `99.0.${Date.now()}`
  const toolDir = path.join(appConfig.toolsDir, 'um-crypto', version)
  const archivePath = `/tmp/x-music-um-crypto-${version}.tgz`
  const fixtureDir = `/tmp/x-music-um-crypto-fixture-${version}`

  try {
    fs.rmSync(toolDir, { recursive: true, force: true })
    const archive = await createUmCryptoPackage({
      fixtureDir,
      archivePath,
      loader: fakeUmCryptoLoader(),
    })
    const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`
    const tarballUrl = `https://release.example/crypto-${version}.tgz`
    let archiveDownloads = 0

    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url)
      if (requestUrl.includes('/api/packages/um/npm/%40unlock-music%2Fcrypto')) {
        return Response.json({
          'dist-tags': { latest: version },
          versions: { [version]: { dist: { integrity, tarball: tarballUrl } } },
        })
      }
      if (requestUrl === tarballUrl) {
        archiveDownloads += 1
        return new Response(new Uint8Array(archive))
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    await refreshUmCrypto()
    const first = await resolveUmCryptoLoaderPath()
    const second = await resolveUmCryptoLoaderPath()
    assert.equal(first, second)
    assert.equal(fs.existsSync(first), true)
    assert.equal(archiveDownloads, 1)
  } finally {
    fs.rmSync(toolDir, { recursive: true, force: true })
    fs.rmSync(fixtureDir, { recursive: true, force: true })
    fs.rmSync(archivePath, { force: true })
    globalThis.fetch = originalFetch
  }
})

test('cache store can serve cached files even if tagging failed', () => {
  const songmid = `FAILED_PLAYABLE_${Date.now()}`
  const rawPath = `/tmp/x-music-failed-playable-${songmid}.mp3`
  fs.writeFileSync(rawPath, 'fake audio')
  try {
    const musicInfo: MusicInfo = {
      source: 'tx',
      songmid,
      name: 'Failed Playable Test',
      singer: 'Tester',
    }

    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, '320k', 'failed', { rawPath, finalPath: rawPath, error: 'tagging failed' })

    const file = getPlayableTrackFile('tx', songmid, '320k')
    assert.equal(file?.rawPath, rawPath)
    assert.equal(file?.finalPath, rawPath)
  } finally {
    fs.unlinkSync(rawPath)
  }
})

test('cache store lists recent play history with track metadata', () => {
  const songmid = `HISTORY_${Date.now()}`
  const musicInfo: MusicInfo = {
    source: 'tx',
    songmid,
    name: 'History Test',
    singer: 'Tester',
    albumName: 'History Album',
  }

  const track = ensureTrack(musicInfo)
  insertPlayEvent(track.id, '320k')

  const history = listPlayHistory(10)
  const record = history.find(item => item.songmid === songmid)
  assert.ok(record)
  assert.equal(record.name, 'History Test')
  assert.equal(record.singer, 'Tester')
  assert.equal(record.albumName, 'History Album')
  assert.equal(record.quality, '320k')
  assert.equal(typeof record.playEventId, 'number')
  assert.ok(record.playedAt)
})

test('resource cache cleanup removes expired resources and keeps recent lx scripts', async () => {
  const now = new Date('2026-05-22T00:00:00.000Z')
  const rows = [
    { key: 'cleanup-old-metadata', type: 'metadata', ageDays: 31, bytes: 11 },
    { key: 'cleanup-recent-metadata', type: 'metadata', ageDays: 1, bytes: 13 },
    { key: 'cleanup-old-image', type: 'image', ageDays: 8, bytes: 17 },
    { key: 'cleanup-recent-image', type: 'image', ageDays: 1, bytes: 19 },
    { key: 'cleanup-lx-1', type: 'lx-script', ageDays: 1, bytes: 23 },
    { key: 'cleanup-lx-2', type: 'lx-script', ageDays: 2, bytes: 29 },
    { key: 'cleanup-lx-3', type: 'lx-script', ageDays: 3, bytes: 31 },
  ]
  const keys = rows.map(row => row.key)

  try {
    for (const row of rows) {
      const timestamp = new Date(now.getTime() - row.ageDays * 24 * 60 * 60 * 1000).toISOString()
      const filePath = `${appConfig.dataDir}/resources/${row.type}/${row.key}.txt`
      fs.mkdirSync(`${appConfig.dataDir}/resources/${row.type}`, { recursive: true })
      fs.writeFileSync(filePath, 'x'.repeat(row.bytes))
      db.prepare(`
        INSERT INTO resource_cache (
          cache_key,
          source,
          resource_type,
          url,
          file_path,
          content_type,
          size_bytes,
          created_at,
          updated_at,
          last_accessed_at
        )
        VALUES (@key, 'test', @type, @url, @filePath, 'text/plain', @bytes, @timestamp, @timestamp, @timestamp)
        ON CONFLICT(cache_key) DO UPDATE SET
          resource_type = excluded.resource_type,
          file_path = excluded.file_path,
          size_bytes = excluded.size_bytes,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          last_accessed_at = excluded.last_accessed_at
      `).run({
        key: row.key,
        type: row.type,
        url: `https://cache-cleanup.example/${row.key}`,
        filePath,
        bytes: row.bytes,
        timestamp,
      })
    }

    const result = await cleanupResourceCache({
      source: 'test',
      now,
      metadataTtlDays: 30,
      imageTtlDays: 7,
      lxScriptTtlDays: 30,
      lxScriptKeepLatest: 2,
    })

    assert.equal(result.deleted, 3)
    assert.equal(Boolean(db.prepare('SELECT 1 FROM resource_cache WHERE cache_key = ?').get('cleanup-old-metadata')), false)
    assert.equal(Boolean(db.prepare('SELECT 1 FROM resource_cache WHERE cache_key = ?').get('cleanup-old-image')), false)
    assert.equal(Boolean(db.prepare('SELECT 1 FROM resource_cache WHERE cache_key = ?').get('cleanup-lx-3')), false)
    assert.ok(db.prepare('SELECT 1 FROM resource_cache WHERE cache_key = ?').get('cleanup-recent-metadata'))
    assert.ok(db.prepare('SELECT 1 FROM resource_cache WHERE cache_key = ?').get('cleanup-recent-image'))
    assert.ok(db.prepare('SELECT 1 FROM resource_cache WHERE cache_key = ?').get('cleanup-lx-1'))
    assert.ok(db.prepare('SELECT 1 FROM resource_cache WHERE cache_key = ?').get('cleanup-lx-2'))
  } finally {
    for (const key of keys) {
      const row = db.prepare('SELECT file_path FROM resource_cache WHERE cache_key = ?').get(key) as { file_path: string } | undefined
      if (row) fs.rmSync(row.file_path, { force: true })
      db.prepare('DELETE FROM resource_cache WHERE cache_key = ?').run(key)
    }
  }
})

test('resource response streams first miss while caching for later hits', async () => {
  const originalFetch = globalThis.fetch
  const url = `https://cache-stream.example/image-${Date.now()}.jpg`
  let secondChunk: (() => void) | undefined
  let fetches = 0

  try {
    db.prepare('DELETE FROM resource_cache WHERE url = ?').run(url)

    globalThis.fetch = (async () => {
      fetches += 1
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('first-'))
          secondChunk = () => {
            controller.enqueue(new TextEncoder().encode('second'))
            controller.close()
          }
        },
      }), {
        headers: {
          'content-type': 'image/jpeg',
          'content-length': '12',
        },
      })
    }) as typeof fetch

    const streamed = await cachedResourceResponse({
      source: 'test',
      resourceType: 'image',
      url,
      timeoutMs: 10_000,
    })
    assert.ok(streamed)
    assert.equal(streamed.response.headers.get('x-x-music-cache'), 'miss')

    const reader = streamed.response.body?.getReader()
    assert.ok(reader)
    const first = await reader.read()
    assert.equal(new TextDecoder().decode(first.value), 'first-')
    assert.equal(Boolean(db.prepare('SELECT 1 FROM resource_cache WHERE url = ?').get(url)), false)

    secondChunk?.()
    const second = await reader.read()
    assert.equal(new TextDecoder().decode(second.value), 'second')
    assert.equal((await reader.read()).done, true)
    await streamed.completion

    const cached = await cachedResourceResponse({
      source: 'test',
      resourceType: 'image',
      url,
      timeoutMs: 10_000,
    })
    assert.ok(cached)
    assert.equal(cached.response.headers.get('x-x-music-cache'), 'hit')
    assert.equal(await cached.response.text(), 'first-second')
    assert.equal(fetches, 1)
  } finally {
    const row = db.prepare('SELECT file_path FROM resource_cache WHERE url = ?').get(url) as { file_path: string } | undefined
    if (row) fs.rmSync(row.file_path, { force: true })
    db.prepare('DELETE FROM resource_cache WHERE url = ?').run(url)
    globalThis.fetch = originalFetch
  }
})

test('empty transformed text resources are not cached', async () => {
  const originalFetch = globalThis.fetch
  const url = `https://cache-text.example/empty-${Date.now()}.json`
  try {
    db.prepare('DELETE FROM resource_cache WHERE url = ?').run(url)
    globalThis.fetch = (async () => Response.json({ code: -1901 })) as typeof fetch

    const text = await getCachedTextResource({
      source: 'test',
      resourceType: 'lyrics',
      url,
      transform: () => '',
    })

    assert.equal(text, undefined)
    assert.equal(Boolean(db.prepare('SELECT 1 FROM resource_cache WHERE url = ?').get(url)), false)
  } finally {
    db.prepare('DELETE FROM resource_cache WHERE url = ?').run(url)
    globalThis.fetch = originalFetch
  }
})

async function createUmCryptoPackage(input: {
  fixtureDir: string
  archivePath: string
  loader: string
}): Promise<Buffer> {
  fs.rmSync(input.fixtureDir, { recursive: true, force: true })
  const distDir = path.join(input.fixtureDir, 'package', 'dist')
  fs.mkdirSync(distDir, { recursive: true })
  fs.writeFileSync(path.join(input.fixtureDir, 'package', 'package.json'), JSON.stringify({
    name: '@unlock-music/crypto',
    version: '0.0.0',
    main: 'dist/loader-inline.js',
  }))
  fs.writeFileSync(path.join(distDir, 'loader-inline.js'), input.loader)
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-czf', input.archivePath, '-C', input.fixtureDir, 'package'])
    child.on('error', reject)
    child.on('exit', (code: number) => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)))
  })
  return fs.readFileSync(input.archivePath)
}

function fakeUmCryptoLoader(input: { requiredEkey?: string; replacementText?: string } = {}): string {
  const replacementText = input.replacementText ?? 'decrypted audio bytes'
  return `
'use strict';
exports.ready = Promise.resolve(true);
exports.QMC2 = class QMC2 {
  constructor(ekey) {
    if (${JSON.stringify(input.requiredEkey ?? '')} && ekey !== ${JSON.stringify(input.requiredEkey ?? '')}) {
      throw new Error('unexpected ekey: ' + ekey);
    }
    this.replacement = ${JSON.stringify(replacementText)};
    this.used = false;
  }
  decrypt(buffer, offset) {
    if (!this.replacement || this.used || offset !== 0) return;
    this.used = true;
    Buffer.from(this.replacement).copy(buffer, 0, 0, Math.min(buffer.length, Buffer.byteLength(this.replacement)));
  }
};
exports.detectAudioType = function detectAudioType(buffer) {
  return { audioType: 'mp3', needMore: false };
};
`
}
