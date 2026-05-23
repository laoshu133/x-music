import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import test from 'node:test'
import { ensureTrack, getPlayableTrackFile, getReadyTrackFile, insertPlayEvent, listPlayHistory, upsertTrackFileStatus } from '@/lib/cache/store'
import { cachedResourceResponse, cleanupResourceCache } from '@/lib/cache/resources'
import { createUpstreamTeeResponse } from '@/lib/cache/stream'
import { EncryptedQQAudioRequiresKeyError } from '@/lib/cache/decrypt'
import { resolveUmCliPath } from '@/lib/cache/um-cli'
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

test('upstream stream rejects encrypted QQ audio containers when UM CLI cannot be resolved', async () => {
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
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url)
      if (requestUrl.includes('/api/v1/repos/um/cli/releases/latest')) {
        return Response.json({ tag_name: 'v0.0.0', assets: [] })
      }
      return new Response('fake encrypted audio', {
        headers: { 'content-type': 'audio/mpeg' },
      })
    }) as typeof fetch

    await assert.rejects(
      createUpstreamTeeResponse(
        `https://ws.stream.qqmusic.qq.com/${songmid}.mgg?vkey=test`,
        track,
        '320k',
        new Request('http://local/play'),
      ),
      /UM CLI release has no asset|compatible asset/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('upstream stream decrypts encrypted QQ audio containers through UM CLI', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `DECRYPTED_STREAM_${Date.now()}`
  const tag = `vdecrypt-${Date.now()}`
  const toolDir = `${appConfig.dataDir}/tools/um/${tag}`
  const archivePath = `/tmp/x-music-um-${tag}.tar.gz`
  const fixtureDir = `/tmp/x-music-um-fixture-${tag}`
  const musicInfo: MusicInfo = {
    source: 'tx',
    songmid,
    name: 'Decrypted Stream Test',
    singer: 'Tester',
  }

  try {
    const archive = await createUmReleaseArchive({
      fixtureDir,
      archivePath,
      script: `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
const args = process.argv.slice(2)
const outputDir = args[args.indexOf('--output') + 1]
const input = args.at(-1)
mkdirSync(outputDir, { recursive: true })
const name = basename(input, extname(input))
writeFileSync(join(outputDir, name + '.mp3'), readFileSync(input))
`,
    })
    fs.rmSync(toolDir, { recursive: true, force: true })
    const hash = createHash('sha256').update(archive).digest('hex')
    const assetName = umAssetName(tag)

    const track = ensureTrack(musicInfo)
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url)
      if (requestUrl.includes('/api/v1/repos/um/cli/releases/latest')) {
        return Response.json({
          tag_name: tag,
          assets: [
            { name: 'sha256sum.txt', browser_download_url: 'https://release.example/sha256sum.txt' },
            { name: assetName, browser_download_url: `https://release.example/${assetName}` },
          ],
        })
      }
      if (requestUrl.endsWith('/sha256sum.txt')) return new Response(`${hash}  ${assetName}\n`)
      if (requestUrl.endsWith(`/${assetName}`)) return new Response(new Uint8Array(archive))
      return new Response('decrypted audio bytes', {
        headers: { 'content-type': 'audio/mpeg' },
      })
    }) as typeof fetch

    const { response, completion } = await createUpstreamTeeResponse(
      `https://ws.stream.qqmusic.qq.com/${songmid}.mgg?vkey=test`,
      track,
      '320k',
      new Request('http://local/play'),
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

test('upstream stream classifies encrypted QQ audio that needs local QQ Music keys', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `QMC_KEY_REQUIRED_${Date.now()}`
  const tag = `vkey-required-${Date.now()}`
  const toolDir = `${appConfig.dataDir}/tools/um/${tag}`
  const archivePath = `/tmp/x-music-um-${tag}.tar.gz`
  const fixtureDir = `/tmp/x-music-um-fixture-${tag}`
  const musicInfo: MusicInfo = {
    source: 'tx',
    songmid,
    name: 'QMC Key Required Test',
    singer: 'Tester',
  }

  try {
    const archive = await createUmReleaseArchive({
      fixtureDir,
      archivePath,
      script: `#!/usr/bin/env node
process.stderr.write('qmc: detect file type failed\\nno any decoder can resolve the file')
process.exit(2)
`,
    })
    fs.rmSync(toolDir, { recursive: true, force: true })
    const hash = createHash('sha256').update(archive).digest('hex')
    const assetName = umAssetName(tag)

    const track = ensureTrack(musicInfo)
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url)
      if (requestUrl.includes('/api/v1/repos/um/cli/releases/latest')) {
        return Response.json({
          tag_name: tag,
          assets: [
            { name: 'sha256sum.txt', browser_download_url: 'https://release.example/sha256sum.txt' },
            { name: assetName, browser_download_url: `https://release.example/${assetName}` },
          ],
        })
      }
      if (requestUrl.endsWith('/sha256sum.txt')) return new Response(`${hash}  ${assetName}\n`)
      if (requestUrl.endsWith(`/${assetName}`)) return new Response(new Uint8Array(archive))
      return new Response('encrypted audio bytes', {
        headers: { 'content-type': 'application/octet-stream' },
      })
    }) as typeof fetch

    await assert.rejects(
      createUpstreamTeeResponse(
        `https://ws.stream.qqmusic.qq.com/${songmid}.mgg?vkey=test`,
        track,
        '320k',
        new Request('http://local/play'),
      ),
      EncryptedQQAudioRequiresKeyError,
    )
  } finally {
    fs.rmSync(toolDir, { recursive: true, force: true })
    fs.rmSync(fixtureDir, { recursive: true, force: true })
    fs.rmSync(archivePath, { force: true })
    globalThis.fetch = originalFetch
  }
})

test('UM CLI resolver downloads and reuses latest release asset', async () => {
  const originalFetch = globalThis.fetch
  const tag = `vtest-${Date.now()}`
  const toolDir = `${appConfig.dataDir}/tools/um/${tag}`
  const archivePath = `/tmp/x-music-um-${tag}.tar.gz`
  const fixtureDir = `/tmp/x-music-um-fixture-${tag}`

  try {
    fs.rmSync(toolDir, { recursive: true, force: true })
    fs.rmSync(fixtureDir, { recursive: true, force: true })
    fs.mkdirSync(fixtureDir, { recursive: true })
    fs.writeFileSync(`${fixtureDir}/um`, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(`${fixtureDir}/um`, 0o755)
    await new Promise<void>((resolve, reject) => {
      const child = spawn('tar', ['-czf', archivePath, '-C', fixtureDir, 'um'])
      child.on('error', reject)
      child.on('exit', (code: number) => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)))
    })
    const archive = fs.readFileSync(archivePath)
    const hash = createHash('sha256').update(archive).digest('hex')
    const assetName = `um-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'x64' ? 'amd64' : 'arm64'}-${tag}.tar.gz`
    let archiveDownloads = 0

    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url)
      if (requestUrl.includes('/api/v1/repos/um/cli/releases/latest')) {
        return Response.json({
          tag_name: tag,
          assets: [
            { name: 'sha256sum.txt', browser_download_url: 'https://release.example/sha256sum.txt' },
            { name: assetName, browser_download_url: `https://release.example/${assetName}` },
          ],
        })
      }
      if (requestUrl.endsWith('/sha256sum.txt')) {
        return new Response(`${hash}  ${assetName}\n`)
      }
      if (requestUrl.endsWith(`/${assetName}`)) {
        archiveDownloads += 1
        return new Response(new Uint8Array(archive))
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const first = await resolveUmCliPath()
    const second = await resolveUmCliPath()
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

function umAssetName(tag: string): string {
  return `um-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'x64' ? 'amd64' : 'arm64'}-${tag}.tar.gz`
}

async function createUmReleaseArchive(input: {
  fixtureDir: string
  archivePath: string
  script: string
}): Promise<Buffer> {
  fs.rmSync(input.fixtureDir, { recursive: true, force: true })
  fs.mkdirSync(input.fixtureDir, { recursive: true })
  fs.writeFileSync(`${input.fixtureDir}/um`, input.script)
  fs.chmodSync(`${input.fixtureDir}/um`, 0o755)
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-czf', input.archivePath, '-C', input.fixtureDir, 'um'])
    child.on('error', reject)
    child.on('exit', (code: number) => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)))
  })
  return fs.readFileSync(input.archivePath)
}
