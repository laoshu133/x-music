import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { db } from '@/lib/db'
import { appConfig } from '@/lib/config'
import { ensureTrack, upsertTrackFileStatus } from '@/lib/cache/store'
import { processOneEmbySyncJob } from '@/lib/emby/sync-worker'
import { enqueueRefreshUmCliJob } from '@/lib/cache/um-cli-job'
import { claimNextJob, clearJobsByStatus, clearStaleRunningJobs, completeJob, createJob, failJob, getJob, requeueJob } from '@/lib/jobs'
import { getJobSummary, listJobs } from '@/lib/jobs/status'
import { processWorkerTick } from '@/worker/index'

test('job lifecycle claim complete and retry states', () => {
  db.prepare("DELETE FROM jobs WHERE type = 'tag_track_file'").run()

  const created = createJob({
    type: 'tag_track_file',
    payload: { trackFileId: Date.now(), rawPath: '/tmp/example.flac' },
  })

  const claimed = claimNextJob<{ trackFileId: number }>({ type: 'tag_track_file' })
  assert.equal(claimed?.id, created.id)
  assert.equal(claimed?.status, 'running')
  assert.equal(claimed?.attempts, 1)

  requeueJob(created.id, 'transient')
  assert.equal(getJob(created.id)?.status, 'queued')
  assert.equal(getJob(created.id)?.error, 'transient')

  const claimedAgain = claimNextJob({ type: 'tag_track_file' })
  assert.equal(claimedAgain?.id, created.id)
  assert.equal(claimedAgain?.attempts, 2)

  failJob(created.id, new Error('terminal'))
  assert.equal(getJob(created.id)?.status, 'failed')
  assert.equal(getJob(created.id)?.error, 'terminal')

  completeJob(created.id)
  assert.equal(getJob(created.id)?.status, 'completed')
  assert.equal(getJob(created.id)?.error, null)
})

test('job status helpers list jobs and summarize states', () => {
  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()

  const queued = createJob({
    type: 'sync_emby_track',
    payload: { source: 'tx', songmid: `JOB_${Date.now()}`, musicInfo: { source: 'tx', songmid: 'a', name: 'A', singer: 'B' } },
  })
  const failed = createJob({
    type: 'sync_emby_track',
    payload: { source: 'tx', songmid: `JOB_FAIL_${Date.now()}`, musicInfo: { source: 'tx', songmid: 'c', name: 'C', singer: 'D' } },
  })
  failJob(failed.id, 'no file')

  const summary = getJobSummary()
  assert.ok(summary.queued >= 1)
  assert.ok(summary.failed >= 1)
  assert.ok(summary.byType.sync_emby_track)

  const listed = listJobs({ type: 'sync_emby_track', limit: 10 })
  assert.ok(listed.some(job => job.id === queued.id))
  assert.ok(listed.some(job => job.id === failed.id))
})

test('stale running jobs are cleared as failed', () => {
  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()

  const stale = createJob({
    type: 'sync_emby_track',
    status: 'running',
    payload: { source: 'tx', songmid: `STALE_${Date.now()}`, musicInfo: { source: 'tx', songmid: 'a', name: 'A', singer: 'B' } },
  })
  const fresh = createJob({
    type: 'sync_emby_track',
    status: 'running',
    payload: { source: 'tx', songmid: `FRESH_${Date.now()}`, musicInfo: { source: 'tx', songmid: 'c', name: 'C', singer: 'D' } },
  })
  db.prepare("UPDATE jobs SET attempts = 1, updated_at = datetime('now', '-1 hour') WHERE id = ?").run(stale.id)

  assert.equal(clearStaleRunningJobs({ olderThanSeconds: 60 }), 1)
  assert.equal(getJob(stale.id)?.status, 'failed')
  assert.equal(getJob(stale.id)?.error, 'Cleared stale running job')
  assert.equal(getJob(fresh.id)?.status, 'running')
})

test('terminal jobs can be cleared by status', () => {
  db.prepare("DELETE FROM jobs WHERE type = 'tag_track_file'").run()
  db.prepare("DELETE FROM jobs WHERE status IN ('failed', 'completed')").run()

  const queued = createJob({
    type: 'tag_track_file',
    payload: { trackFileId: Date.now(), rawPath: '/tmp/queued.flac' },
  })
  const running = createJob({
    type: 'tag_track_file',
    status: 'running',
    payload: { trackFileId: Date.now() + 1, rawPath: '/tmp/running.flac' },
  })
  const failed = createJob({
    type: 'tag_track_file',
    payload: { trackFileId: Date.now() + 2, rawPath: '/tmp/failed.flac' },
  })
  const completed = createJob({
    type: 'tag_track_file',
    payload: { trackFileId: Date.now() + 3, rawPath: '/tmp/completed.flac' },
  })
  failJob(failed.id, 'terminal')
  completeJob(completed.id)

  assert.equal(clearJobsByStatus('failed'), 1)
  assert.equal(getJob(failed.id), null)
  assert.equal(getJob(completed.id)?.status, 'completed')
  assert.equal(getJob(queued.id)?.status, 'queued')
  assert.equal(getJob(running.id)?.status, 'running')

  assert.equal(clearJobsByStatus('completed'), 1)
  assert.equal(getJob(completed.id), null)
  assert.equal(getJob(queued.id)?.status, 'queued')
  assert.equal(getJob(running.id)?.status, 'running')
})

test('emby sync job fails after max attempts when no cached file exists', async () => {
  const songmid = `SYNC_MISSING_${Date.now()}`
  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()

  const created = createJob({
    type: 'sync_emby_track',
    payload: {
      source: 'tx',
      songmid,
      musicInfo: { source: 'tx', songmid, name: 'Missing Sync', singer: 'Tester' },
    },
  })

  assert.equal(await processOneEmbySyncJob({
    maxAttempts: 1,
    cacheWaitMs: 0,
  }), true)
  const job = getJob(created.id)
  assert.equal(job?.status, 'failed')
  assert.equal(job?.error, 'No cached file is ready for Emby sync yet')
})

test('emby sync job waits for cached media before failing', async () => {
  const originalFetch = globalThis.fetch
  const originalWebdavDsn = process.env.EMBY_SOURCE_WEBDAV_DSN
  const songmid = `SYNC_WAIT_CACHE_${Date.now()}`
  const rawPath = `/tmp/x-music-${songmid}.mp3`

  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  writeFileSync(rawPath, 'fake audio')
  delete process.env.EMBY_SOURCE_WEBDAV_DSN
  try {
    const musicInfo = { source: 'tx' as const, songmid, name: 'Delayed Cache Sync', singer: 'Tester' }
    const track = ensureTrack(musicInfo)
    const created = createJob({
      type: 'sync_emby_track',
      payload: { source: 'tx', songmid, musicInfo },
    })

    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.pathname.endsWith('/Library/Media/Updated')) return new Response(null, { status: 204 })
      if (requestUrl.pathname.endsWith('/Items')) {
        return Response.json({ Items: [{ Id: 'emby-delayed-cache-song', Name: 'Delayed Cache Sync', Artists: ['Tester'] }] })
      }
      return Response.json({}, { status: 404 })
    }) as typeof fetch

    const result = processOneEmbySyncJob({
      maxAttempts: 1,
      cacheWaitMs: 100,
      cachePollIntervalMs: 1,
      scanWaitMs: 0,
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: rawPath, rawPath })

    assert.equal(await result, true)
    assert.equal(getJob(created.id)?.status, 'completed')
  } finally {
    rmSync(rawPath, { force: true })
    process.env.EMBY_SOURCE_WEBDAV_DSN = originalWebdavDsn
    globalThis.fetch = originalFetch
  }
})

test('worker tick gives emby sync a turn when tag processing did work', async () => {
  const calls: string[] = []
  const didWork = await processWorkerTick({
    scheduleCleanupResourceCacheJob: false,
    async processTagJob() {
      calls.push('tag')
      return true
    },
    async processEmbySyncJob() {
      calls.push('emby')
      return true
    },
    async processCleanupResourceCacheJob() {
      calls.push('cleanup')
      return false
    },
  })

  assert.equal(didWork, true)
  assert.deepEqual(calls, ['tag', 'emby', 'cleanup'])
})

test('worker tick processes queued UM CLI refresh jobs', async () => {
  const calls: string[] = []
  const didWork = await processWorkerTick({
    scheduleCleanupResourceCacheJob: false,
    async processRefreshUmCliJob() {
      calls.push('um')
      return true
    },
    async processTagJob() {
      calls.push('tag')
      return false
    },
    async processEmbySyncJob() {
      calls.push('emby')
      return false
    },
    async processCleanupResourceCacheJob() {
      calls.push('cleanup')
      return false
    },
  })

  assert.equal(didWork, true)
  assert.deepEqual(calls, ['um', 'tag', 'emby', 'cleanup'])
})

test('UM CLI refresh job downloads latest release once and reuses local version', async () => {
  const originalFetch = globalThis.fetch
  const tag = `vjob-${Date.now()}`
  const toolDir = path.join(appConfig.toolsDir, 'um', tag)
  const archivePath = `/tmp/x-music-um-job-${tag}.tar.gz`
  const fixtureDir = `/tmp/x-music-um-job-fixture-${tag}`

  try {
    db.prepare("DELETE FROM jobs WHERE type = 'refresh_um_cli'").run()
    rmSync(toolDir, { recursive: true, force: true })
    rmSync(fixtureDir, { recursive: true, force: true })
    mkdirSync(fixtureDir, { recursive: true })
    writeFileSync(path.join(fixtureDir, 'um'), '#!/bin/sh\nexit 0\n')
    await new Promise<void>((resolve, reject) => {
      const child = spawn('tar', ['-czf', archivePath, '-C', fixtureDir, 'um'])
      child.on('error', reject)
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)))
    })

    const archive = readFileSync(archivePath)
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
      if (requestUrl.endsWith('/sha256sum.txt')) return new Response(`${hash}  ${assetName}\n`)
      if (requestUrl.endsWith(`/${assetName}`)) {
        archiveDownloads += 1
        return new Response(new Uint8Array(archive))
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    enqueueRefreshUmCliJob({ reason: 'startup' })
    assert.equal(await processWorkerTick({
      scheduleCleanupResourceCacheJob: false,
      processTagJob: async () => false,
      processEmbySyncJob: async () => false,
      processCleanupResourceCacheJob: async () => false,
    }), true)
    assert.equal(archiveDownloads, 1)

    enqueueRefreshUmCliJob({ reason: 'startup' })
    assert.equal(await processWorkerTick({
      scheduleCleanupResourceCacheJob: false,
      processTagJob: async () => false,
      processEmbySyncJob: async () => false,
      processCleanupResourceCacheJob: async () => false,
    }), true)
    assert.equal(archiveDownloads, 1)
  } finally {
    rmSync(toolDir, { recursive: true, force: true })
    rmSync(fixtureDir, { recursive: true, force: true })
    rmSync(archivePath, { force: true })
    db.prepare("DELETE FROM jobs WHERE type = 'refresh_um_cli'").run()
    globalThis.fetch = originalFetch
  }
})

test('emby sync job does not complete when scan cannot find item', async () => {
  const originalFetch = globalThis.fetch
  const originalWebdavDsn = process.env.EMBY_SOURCE_WEBDAV_DSN
  const songmid = `SYNC_NOT_FOUND_${Date.now()}`
  const rawPath = `/tmp/x-music-${songmid}.mp3`
  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  writeFileSync(rawPath, 'fake audio')
  delete process.env.EMBY_SOURCE_WEBDAV_DSN
  try {
    const musicInfo = { source: 'tx' as const, songmid, name: 'Not Found Sync', singer: 'Tester' }
    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: rawPath, rawPath })
    const created = createJob({
      type: 'sync_emby_track',
      payload: { source: 'tx', songmid, musicInfo },
    })

    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.pathname.endsWith('/Library/Media/Updated')) return new Response(null, { status: 204 })
      if (requestUrl.pathname.endsWith('/Items')) return Response.json({ Items: [] })
      return Response.json({}, { status: 404 })
    }) as typeof fetch

    assert.equal(await processOneEmbySyncJob({
      maxAttempts: 1,
      scanWaitMs: 0,
    }), true)
    const job = getJob(created.id)
    assert.equal(job?.status, 'failed')
    assert.match(job?.error ?? '', /item was not found/)
  } finally {
    rmSync(rawPath, { force: true })
    process.env.EMBY_SOURCE_WEBDAV_DSN = originalWebdavDsn
    globalThis.fetch = originalFetch
  }
})

test('emby sync job ignores non-matching Emby search fallback item', async () => {
  const originalFetch = globalThis.fetch
  const originalWebdavDsn = process.env.EMBY_SOURCE_WEBDAV_DSN
  const songmid = `SYNC_MISMATCH_${Date.now()}`
  const rawPath = `/tmp/x-music-${songmid}.mp3`
  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  writeFileSync(rawPath, 'fake audio')
  delete process.env.EMBY_SOURCE_WEBDAV_DSN
  try {
    const musicInfo = { source: 'tx' as const, songmid, name: 'Expected Sync Song', singer: 'Expected Artist' }
    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: rawPath, rawPath })
    const created = createJob({
      type: 'sync_emby_track',
      payload: { source: 'tx', songmid, musicInfo },
    })

    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.pathname.endsWith('/Library/Media/Updated')) return new Response(null, { status: 204 })
      if (requestUrl.pathname.endsWith('/Items')) {
        return Response.json({ Items: [{ Id: 'wrong-emby-song', Name: 'Different Song', Artists: ['Different Artist'] }] })
      }
      return Response.json({}, { status: 404 })
    }) as typeof fetch

    assert.equal(await processOneEmbySyncJob({
      maxAttempts: 1,
      scanWaitMs: 0,
    }), true)
    const job = getJob(created.id)
    assert.equal(job?.status, 'failed')
    assert.match(job?.error ?? '', /item was not found/)
  } finally {
    rmSync(rawPath, { force: true })
    process.env.EMBY_SOURCE_WEBDAV_DSN = originalWebdavDsn
    globalThis.fetch = originalFetch
  }
})

test('emby sync job fails unsupported audio containers without scanning Emby', async () => {
  const originalFetch = globalThis.fetch
  const originalWebdavDsn = process.env.EMBY_SOURCE_WEBDAV_DSN
  const songmid = `SYNC_UNSUPPORTED_${Date.now()}`
  const rawPath = `/tmp/x-music-${songmid}.mgg`
  const requests: string[] = []

  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  writeFileSync(rawPath, 'fake encrypted audio')
  delete process.env.EMBY_SOURCE_WEBDAV_DSN
  try {
    const musicInfo = { source: 'tx' as const, songmid, name: 'Unsupported Sync', singer: 'Tester' }
    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: rawPath, rawPath })
    const created = createJob({
      type: 'sync_emby_track',
      payload: { source: 'tx', songmid, musicInfo },
    })

    globalThis.fetch = (async (url: string | URL | Request) => {
      requests.push(String(url))
      return Response.json({}, { status: 500 })
    }) as typeof fetch

    assert.equal(await processOneEmbySyncJob(1), true)
    const job = getJob(created.id)
    assert.equal(job?.status, 'failed')
    assert.match(job?.error ?? '', /not syncable to Emby/)
    assert.deepEqual(requests, [])
  } finally {
    rmSync(rawPath, { force: true })
    process.env.EMBY_SOURCE_WEBDAV_DSN = originalWebdavDsn
    globalThis.fetch = originalFetch
  }
})

test('emby sync job does not create Emby playlists from virtual playlist ids', async () => {
  const originalFetch = globalThis.fetch
  const originalWebdavDsn = process.env.EMBY_SOURCE_WEBDAV_DSN
  const songmid = `SYNC_VIRTUAL_PLAYLIST_${Date.now()}`
  const rawPath = `/tmp/x-music-${songmid}.mp3`
  const requests: Array<{ method: string; pathname: string; search: string }> = []
  const playlistId = 'mix_eyJraW5kIjoicXEtcGxheWxpc3QiLCJpZCI6IjkyMTg3MTg2NjcifQ'

  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  writeFileSync(rawPath, 'fake audio')
  delete process.env.EMBY_SOURCE_WEBDAV_DSN
  try {
    const musicInfo = { source: 'tx' as const, songmid, name: 'Virtual Playlist Sync', singer: 'Tester' }
    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: rawPath, rawPath })
    const created = createJob({
      type: 'sync_emby_track',
      payload: { source: 'tx', songmid, playlistId, musicInfo },
    })

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      requests.push({
        method: init?.method ?? 'GET',
        pathname: requestUrl.pathname,
        search: requestUrl.search,
      })
      if (requestUrl.pathname.endsWith('/Library/Media/Updated')) return new Response(null, { status: 204 })
      if (requestUrl.pathname.endsWith('/Items')) {
        return Response.json({ Items: [{ Id: 'emby-virtual-playlist-song', Name: 'Virtual Playlist Sync', Artists: ['Tester'] }] })
      }
      return Response.json({}, { status: 404 })
    }) as typeof fetch

    assert.equal(await processOneEmbySyncJob(1), true)
    assert.equal(getJob(created.id)?.status, 'completed')
    assert.ok(!requests.some(request => request.pathname.endsWith('/Playlists')))
    assert.ok(!requests.some(request => request.search.includes('QQ+mix_')))
  } finally {
    rmSync(rawPath, { force: true })
    process.env.EMBY_SOURCE_WEBDAV_DSN = originalWebdavDsn
    globalThis.fetch = originalFetch
  }
})

test('emby sync job waits for asynchronous Emby scan results', async () => {
  const originalFetch = globalThis.fetch
  const originalWebdavDsn = process.env.EMBY_SOURCE_WEBDAV_DSN
  const songmid = `SYNC_WAIT_FOUND_${Date.now()}`
  const rawPath = `/tmp/x-music-${songmid}.mp3`
  let searchCount = 0

  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  writeFileSync(rawPath, 'fake audio')
  delete process.env.EMBY_SOURCE_WEBDAV_DSN
  try {
    const musicInfo = { source: 'tx' as const, songmid, name: 'Delayed Scan Sync', singer: 'Tester' }
    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: rawPath, rawPath })
    const created = createJob({
      type: 'sync_emby_track',
      payload: { source: 'tx', songmid, musicInfo },
    })

    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.pathname.endsWith('/Library/Media/Updated')) return new Response(null, { status: 204 })
      if (requestUrl.pathname.endsWith('/Items')) {
        if (requestUrl.searchParams.has('Path')) return Response.json({ Items: [] })
        searchCount += 1
        return Response.json({
          Items: searchCount === 1
            ? []
            : [{ Id: 'emby-delayed-scan-song', Name: 'Delayed Scan Sync', Artists: ['Tester'] }],
        })
      }
      return Response.json({}, { status: 404 })
    }) as typeof fetch

    assert.equal(await processOneEmbySyncJob({
      maxAttempts: 1,
      scanWaitMs: 100,
      scanPollIntervalMs: 1,
    }), true)
    assert.equal(searchCount, 2)
    assert.equal(getJob(created.id)?.status, 'completed')
  } finally {
    rmSync(rawPath, { force: true })
    process.env.EMBY_SOURCE_WEBDAV_DSN = originalWebdavDsn
    globalThis.fetch = originalFetch
  }
})

test('emby sync job uploads ready media through WebDAV before scanning Emby', async () => {
  const originalFetch = globalThis.fetch
  const originalWebdavDsn = process.env.EMBY_SOURCE_WEBDAV_DSN
  const songmid = `SYNC_WEBDAV_${Date.now()}`
  const relativeDir = path.join('WebDAV Artist', 'WebDAV Album')
  const finalPath = path.join(appConfig.musicDir, relativeDir, 'WebDAV Artist - WebDAV Song.flac')
  const lyricsPath = path.join(appConfig.musicDir, relativeDir, 'WebDAV Artist - WebDAV Song.lrc')
  const coverPath = path.join(appConfig.musicDir, relativeDir, 'cover.jpg')
  const requests: Array<{ method: string; pathname: string; search?: string; body?: string }> = []

  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  db.prepare("DELETE FROM app_settings WHERE key = 'emby.upstreamMusicLibraryMapping'").run()
  mkdirSync(path.dirname(finalPath), { recursive: true })
  writeFileSync(finalPath, 'fake audio')
  writeFileSync(lyricsPath, '[00:00.00]WebDAV Song')
  writeFileSync(coverPath, 'fake cover')
  process.env.EMBY_SOURCE_WEBDAV_DSN = 'https://webdav-user:webdav-pass@webdav.example/dav/music'

  try {
    const musicInfo = { source: 'tx' as const, songmid, name: 'WebDAV Song', singer: 'WebDAV Artist' }
    const track = ensureTrack(musicInfo)
    const trackFile = upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath })
    db.prepare(`
      UPDATE track_files
      SET lyrics_path = ?, cover_path = ?
      WHERE id = ?
    `).run(lyricsPath, coverPath, trackFile.id)
    const created = createJob({
      type: 'sync_emby_track',
      payload: { source: 'tx', songmid, musicInfo },
    })

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      const method = init?.method ?? 'GET'
      if (requestUrl.hostname === 'webdav.example') {
        if (method === 'PUT' && init?.body && typeof (init.body as { resume?: unknown }).resume === 'function') {
          await new Promise<void>((resolve, reject) => {
            const stream = init.body as unknown as NodeJS.ReadableStream
            stream.on('end', resolve)
            stream.on('error', reject)
            stream.resume()
          })
        }
        requests.push({
          method,
          pathname: requestUrl.pathname,
          search: requestUrl.search,
          body: init?.body ? 'body' : undefined,
        })
        return new Response(null, { status: method === 'PUT' ? 204 : 201 })
      }
      if (requestUrl.pathname.endsWith('/Library/VirtualFolders')) {
        return Response.json([{
          Name: '音乐',
          CollectionType: 'music',
          ItemId: 'music-root',
          Guid: 'music-guid',
          Locations: ['/volume1/music'],
        }])
      }
      if (requestUrl.pathname.endsWith('/Library/Media/Updated')) {
        requests.push({
          method,
          pathname: requestUrl.pathname,
          search: requestUrl.search,
          body: String(init?.body ?? ''),
        })
        return new Response(null, { status: 204 })
      }
      if (requestUrl.pathname.endsWith('/Items')) {
        requests.push({
          method,
          pathname: requestUrl.pathname,
          search: requestUrl.search,
        })
        if (requestUrl.searchParams.has('Path')) {
          return Response.json({
            Items: [{
              Id: 'emby-webdav-song',
              Name: 'Unexpected Name',
              Artists: ['Unexpected Artist'],
              Path: '/volume1/music/WebDAV Artist/WebDAV Album/WebDAV Artist - WebDAV Song.flac',
            }],
          })
        }
        return Response.json({ Items: [] })
      }
      return Response.json({}, { status: 404 })
    }) as typeof fetch

    assert.equal(await processOneEmbySyncJob(1), true)
    assert.equal(getJob(created.id)?.status, 'completed')
    assert.deepEqual(
      requests
        .filter(request => request.pathname.startsWith('/dav/music/'))
        .map(request => `${request.method} ${decodeURIComponent(request.pathname)}`),
      [
        'MKCOL /dav/music/WebDAV Artist',
        'MKCOL /dav/music/WebDAV Artist/WebDAV Album',
        'PUT /dav/music/WebDAV Artist/WebDAV Album/WebDAV Artist - WebDAV Song.flac',
        'PUT /dav/music/WebDAV Artist/WebDAV Album/WebDAV Artist - WebDAV Song.lrc',
        'PUT /dav/music/WebDAV Artist/WebDAV Album/cover.jpg',
      ],
    )
    const mediaUpdated = requests.find(request => request.pathname.endsWith('/Library/Media/Updated'))
    assert.match(mediaUpdated?.body ?? '', /\/volume1\/music\/WebDAV Artist\/WebDAV Album\/WebDAV Artist - WebDAV Song\.flac/)
    const itemSearch = requests.find(request => request.pathname.endsWith('/Items') && request.search?.includes('Path='))
    assert.match(itemSearch?.search ?? '', /Path=.*%2Fvolume1%2Fmusic%2FWebDAV\+Artist%2FWebDAV\+Album%2FWebDAV\+Artist\+-\+WebDAV\+Song\.flac/)
  } finally {
    rmSync(path.join(appConfig.musicDir, 'WebDAV Artist'), { recursive: true, force: true })
    process.env.EMBY_SOURCE_WEBDAV_DSN = originalWebdavDsn
    globalThis.fetch = originalFetch
  }
})

test('emby sync job waits for library final path before WebDAV upload', async () => {
  const originalFetch = globalThis.fetch
  const originalWebdavDsn = process.env.EMBY_SOURCE_WEBDAV_DSN
  const songmid = `SYNC_WAIT_LIBRARY_${Date.now()}`
  const inboxPath = path.join(appConfig.inboxDir, `${songmid}.mp3`)
  const webdavRequests: string[] = []

  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  mkdirSync(appConfig.inboxDir, { recursive: true })
  writeFileSync(inboxPath, 'fake audio')
  process.env.EMBY_SOURCE_WEBDAV_DSN = 'https://webdav-user:webdav-pass@webdav.example/dav/music'
  try {
    const musicInfo = { source: 'tx' as const, songmid, name: 'Library Wait Sync', singer: 'Tester' }
    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: inboxPath, rawPath: inboxPath })
    const created = createJob({
      type: 'sync_emby_track',
      payload: { source: 'tx', songmid, musicInfo },
    })

    globalThis.fetch = (async (url: string | URL | Request) => {
      webdavRequests.push(String(url))
      return Response.json({ error: 'should not upload inbox path' }, { status: 500 })
    }) as typeof fetch

    assert.equal(await processOneEmbySyncJob({
      maxAttempts: 1,
      cacheWaitMs: 0,
    }), true)
    const job = getJob(created.id)
    assert.equal(job?.status, 'failed')
    assert.equal(job?.error, 'No cached file is ready for Emby sync yet')
    assert.deepEqual(webdavRequests, [])
  } finally {
    rmSync(inboxPath, { force: true })
    process.env.EMBY_SOURCE_WEBDAV_DSN = originalWebdavDsn
    globalThis.fetch = originalFetch
  }
})

test('emby sync job does not apply favorite state', async () => {
  const originalFetch = globalThis.fetch
  const originalWebdavDsn = process.env.EMBY_SOURCE_WEBDAV_DSN
  const songmid = `SYNC_FAVORITE_${Date.now()}`
  const rawPath = `/tmp/x-music-${songmid}.mp3`
  const requests: Array<{ method: string; pathname: string }> = []

  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  writeFileSync(rawPath, 'fake audio')
  delete process.env.EMBY_SOURCE_WEBDAV_DSN
  try {
    const musicInfo = { source: 'tx' as const, songmid, name: 'Favorite Sync Song', singer: 'Favorite Artist' }
    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: rawPath, rawPath })
    const created = createJob({
      type: 'sync_emby_track',
      payload: {
        source: 'tx',
        songmid,
        musicInfo,
      },
    })

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      const method = init?.method ?? 'GET'
      requests.push({ method, pathname: requestUrl.pathname })
      if (requestUrl.pathname.endsWith('/Library/Media/Updated')) return new Response(null, { status: 204 })
      if (requestUrl.pathname.endsWith('/Items')) {
        return Response.json({ Items: [{ Id: 'emby-favorite-song', Name: 'Favorite Sync Song', Artists: ['Favorite Artist'] }] })
      }
      return Response.json({}, { status: 404 })
    }) as typeof fetch

    assert.equal(await processOneEmbySyncJob(1), true)
    assert.equal(getJob(created.id)?.status, 'completed')
    assert.ok(!requests.some(request => request.pathname.includes('/FavoriteItems/')))
  } finally {
    rmSync(rawPath, { force: true })
    process.env.EMBY_SOURCE_WEBDAV_DSN = originalWebdavDsn
    globalThis.fetch = originalFetch
  }
})
