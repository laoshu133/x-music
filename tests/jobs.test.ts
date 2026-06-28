import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { db } from '@/lib/db'
import { appConfig } from '@/lib/config'
import { ensureTrack, upsertTrackFileStatus } from '@/lib/cache/store'
import { hasEmbySyncableCachedMedia, processOneEmbySyncJob } from '@/lib/emby/sync-worker'
import { processOneArchiveTrackJob } from '@/lib/archive/track'
import { enqueueRefreshUmCryptoJob } from '@/lib/cache/um-crypto-job'
import { getRemoteMapping, getRemoteMappingByRemote, upsertRemoteMapping } from '@/lib/db/remote-mappings'
import { claimNextJob, clearJobsByStatus, clearStaleRunningJobs, completeJob, createJob, failJob, getJob, requeueJob } from '@/lib/jobs'
import { getJobSummary, listJobs } from '@/lib/jobs/status'
import { processWorkerTick } from '@/worker/index'
import { saveQQLoginCookie } from '@/lib/db/qq-session'
import { setLocalFavoriteSynced } from '@/lib/db/favorites'

const TEST_EMBY_QQ_UIN = '998001'
const TEST_EMBY_WEBDAV_DSN = 'https://webdav-user:webdav-pass@webdav.example/dav/music'

function configureTestAccountEmby(options: { webdav?: boolean } = {}): void {
  saveQQLoginCookie(`uin=o${TEST_EMBY_QQ_UIN}; qm_keyst=test-key`)
  db.prepare(`
    UPDATE accounts
    SET emby_base_url = @baseUrl,
        emby_api_key = @apiKey,
        emby_source_webdav_dsn = @sourceWebdavDsn,
        emby_proxy_timeout_ms = 30000,
        emby_user_id = @embyUserId,
        emby_access_token = @embyAccessToken
    WHERE qq_uin = @qqUin
  `).run({
    qqUin: TEST_EMBY_QQ_UIN,
    baseUrl: 'http://127.0.0.1:8096',
    apiKey: 'test-emby-api-key',
    sourceWebdavDsn: options.webdav ? TEST_EMBY_WEBDAV_DSN : null,
    embyUserId: `emby-user-${TEST_EMBY_QQ_UIN}`,
    embyAccessToken: `emby-token-${TEST_EMBY_QQ_UIN}`,
  })
}

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
  const requeued = getJob(created.id)
  assert.equal(requeued?.status, 'queued')
  assert.equal(requeued?.error, 'transient')
  assert.ok(requeued?.nextRunAt)

  assert.equal(claimNextJob({ type: 'tag_track_file' }), null)
  db.prepare("UPDATE jobs SET next_run_at = datetime('now', '-1 second') WHERE id = ?").run(created.id)
  const claimedAgain = claimNextJob({ type: 'tag_track_file' })
  assert.equal(claimedAgain?.id, created.id)
  assert.equal(claimedAgain?.attempts, 2)
  assert.equal(claimedAgain?.nextRunAt, null)

  failJob(created.id, new Error('terminal'))
  assert.equal(getJob(created.id)?.status, 'failed')
  assert.equal(getJob(created.id)?.error, 'terminal')

  completeJob(created.id)
  assert.equal(getJob(created.id)?.status, 'completed')
  assert.equal(getJob(created.id)?.error, null)
})

test('remote emby mappings are isolated by QQ user', () => {
  const songmid = `REMOTE_MAPPING_USER_${Date.now()}`
  const localKey = `tx:${songmid}`
  db.prepare("DELETE FROM remote_mappings WHERE local_type = 'track' AND local_key = ? AND remote = 'emby'").run(localKey)
  try {
    upsertRemoteMapping({
      qqUin: 'user-a',
      localType: 'track',
      localKey,
      remote: 'emby',
      remoteId: 'emby-user-a-track',
    })
    upsertRemoteMapping({
      qqUin: 'user-b',
      localType: 'track',
      localKey,
      remote: 'emby',
      remoteId: 'emby-user-b-track',
    })

    assert.equal(getRemoteMapping({ qqUin: 'user-a', localType: 'track', localKey, remote: 'emby' })?.remoteId, 'emby-user-a-track')
    assert.equal(getRemoteMapping({ qqUin: 'user-b', localType: 'track', localKey, remote: 'emby' })?.remoteId, 'emby-user-b-track')
    assert.equal(getRemoteMappingByRemote({ qqUin: 'user-a', remote: 'emby', remoteId: 'emby-user-b-track' })?.localKey, undefined)
    assert.equal(getRemoteMappingByRemote({ qqUin: 'user-b', remote: 'emby', remoteId: 'emby-user-b-track' })?.localKey, localKey)
  } finally {
    db.prepare("DELETE FROM remote_mappings WHERE local_type = 'track' AND local_key = ? AND remote = 'emby'").run(localKey)
  }
})

test('job status helpers list jobs and summarize states', () => {
  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()

  const queued = createJob({
    type: 'sync_emby_track',
    payload: { source: 'tx', qqUin: TEST_EMBY_QQ_UIN, songmid: `JOB_${Date.now()}`, musicInfo: { source: 'tx', songmid: 'a', name: 'A', singer: 'B' } },
  })
  const failed = createJob({
    type: 'sync_emby_track',
    payload: { source: 'tx', qqUin: TEST_EMBY_QQ_UIN, songmid: `JOB_FAIL_${Date.now()}`, musicInfo: { source: 'tx', songmid: 'c', name: 'C', singer: 'D' } },
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

test('stale running jobs are recovered until max attempts', () => {
  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()

  const retryable = createJob({
    type: 'sync_emby_track',
    status: 'running',
    payload: { source: 'tx', qqUin: TEST_EMBY_QQ_UIN, songmid: `STALE_${Date.now()}`, musicInfo: { source: 'tx', songmid: 'a', name: 'A', singer: 'B' } },
  })
  const exhausted = createJob({
    type: 'sync_emby_track',
    status: 'running',
    payload: { source: 'tx', qqUin: TEST_EMBY_QQ_UIN, songmid: `STALE_EXHAUSTED_${Date.now()}`, musicInfo: { source: 'tx', songmid: 'b', name: 'B', singer: 'C' } },
  })
  const fresh = createJob({
    type: 'sync_emby_track',
    status: 'running',
    payload: { source: 'tx', qqUin: TEST_EMBY_QQ_UIN, songmid: `FRESH_${Date.now()}`, musicInfo: { source: 'tx', songmid: 'c', name: 'C', singer: 'D' } },
  })
  db.prepare("UPDATE jobs SET attempts = 1, updated_at = datetime('now', '-1 hour') WHERE id = ?").run(retryable.id)
  db.prepare("UPDATE jobs SET attempts = 3, updated_at = datetime('now', '-1 hour') WHERE id = ?").run(exhausted.id)

  assert.deepEqual(clearStaleRunningJobs({ olderThanSeconds: 60, maxAttempts: 3 }), { requeued: 1, failed: 1 })
  assert.equal(getJob(retryable.id)?.status, 'queued')
  assert.equal(getJob(retryable.id)?.error, 'Recovered stale running job')
  assert.ok(getJob(retryable.id)?.nextRunAt)
  assert.equal(getJob(exhausted.id)?.status, 'failed')
  assert.equal(getJob(exhausted.id)?.error, 'Cleared stale running job after max attempts')
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
  configureTestAccountEmby()

  const created = createJob({
    type: 'sync_emby_track',
    payload: {
      source: 'tx',
      qqUin: TEST_EMBY_QQ_UIN,
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
  const songmid = `SYNC_WAIT_CACHE_${Date.now()}`
  const rawPath = `/tmp/x-music-${songmid}.mp3`

  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  writeFileSync(rawPath, 'fake audio')
  configureTestAccountEmby()
  try {
    const musicInfo = {
      source: 'tx' as const,
      songmid,
      name: 'Delayed Cache Sync',
      singer: 'Tester',
      types: [{ type: '320k' as const, size: '5 MB' }],
    }
    const track = ensureTrack(musicInfo)
    const created = createJob({
      type: 'sync_emby_track',
      payload: { source: 'tx', qqUin: TEST_EMBY_QQ_UIN, songmid, musicInfo },
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
    globalThis.fetch = originalFetch
  }
})

test('emby sync job prefers highest ready quality over newer low quality cache', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `SYNC_BEST_QUALITY_${Date.now()}`
  const dir = path.join(appConfig.musicDir, 'Best Quality Artist', songmid)
  const flacPath = path.join(dir, 'Best Quality Artist - Best Quality Song.flac')
  const oggPath = path.join(dir, 'Best Quality Artist - Best Quality Song.ogg')
  const scanPaths: string[] = []

  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  mkdirSync(dir, { recursive: true })
  writeFileSync(flacPath, 'flac audio')
  writeFileSync(oggPath, 'ogg audio')
  configureTestAccountEmby({ webdav: true })
  try {
    const musicInfo = { source: 'tx' as const, songmid, name: 'Best Quality Song', singer: 'Best Quality Artist' }
    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, 'flac', 'ready', { finalPath: flacPath, sizeBytes: 49_000_000 })
    upsertTrackFileStatus(track.id, '128k', 'ready', { finalPath: oggPath, sizeBytes: 3_000_000 })
    const created = createJob({
      type: 'sync_emby_track',
      payload: { source: 'tx', qqUin: TEST_EMBY_QQ_UIN, songmid, musicInfo },
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
        if (method === 'HEAD') return new Response(null, { status: 404 })
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
      if (requestUrl.pathname.endsWith('/Library/Media/Updated')) return new Response(null, { status: 204 })
      if (requestUrl.pathname.endsWith('/Items') && requestUrl.searchParams.has('Path')) {
        scanPaths.push(requestUrl.searchParams.get('Path') ?? '')
        return Response.json({
          Items: [{
            Id: 'emby-best-quality-song',
            Name: 'Best Quality Song',
            Artists: ['Best Quality Artist'],
            Path: requestUrl.searchParams.get('Path'),
          }],
        })
      }
      return Response.json({ Items: [] })
    }) as typeof fetch

    assert.equal(await processOneEmbySyncJob(1), true)
    assert.equal(getJob(created.id)?.status, 'completed')
    assert.equal(path.extname(scanPaths[0] ?? ''), '.flac')
    const flacRow = db.prepare(`
      SELECT final_path AS finalPath
      FROM track_files tf
      INNER JOIN tracks t ON t.id = tf.track_id
      WHERE t.source = 'tx' AND t.songmid = ? AND tf.quality = 'flac'
    `).get(songmid) as { finalPath: string | null } | undefined
    assert.equal(flacRow?.finalPath, null)
  } finally {
    rmSync(path.join(appConfig.musicDir, 'Best Quality Artist'), { recursive: true, force: true })
    globalThis.fetch = originalFetch
  }
})

test('emby sync job marks stale missing highest quality without falling back to lower quality', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `SYNC_STALE_CACHE_${Date.now()}`
  const missingFlacPath = path.join(appConfig.musicDir, 'missing', `${songmid}.flac`)
  const oggPath = path.join(appConfig.musicDir, 'Tester', 'Unknown Album', `Tester - ${songmid}.ogg`)

  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  mkdirSync(path.dirname(oggPath), { recursive: true })
  writeFileSync(oggPath, 'ogg audio')
  configureTestAccountEmby()
  try {
    const musicInfo = {
      source: 'tx' as const,
      songmid,
      name: 'Stale Cache Sync',
      singer: 'Tester',
      types: [{ type: 'flac' as const, size: '49 MB' }, { type: '320k' as const, size: '5 MB' }],
    }
    const track = ensureTrack(musicInfo)
    const flac = upsertTrackFileStatus(track.id, 'flac', 'ready', { finalPath: missingFlacPath, sizeBytes: 49_000_000 })
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: oggPath, sizeBytes: 5_000_000 })
    const created = createJob({
      type: 'sync_emby_track',
      payload: { source: 'tx', qqUin: TEST_EMBY_QQ_UIN, songmid, musicInfo },
    })

    globalThis.fetch = (async () => Response.json({ error: 'should not scan lower quality' }, { status: 500 })) as typeof fetch

    assert.equal(await processOneEmbySyncJob({
      maxAttempts: 1,
      cacheWaitMs: 0,
      scanWaitMs: 0,
    }), true)
    const job = getJob(created.id)
    assert.equal(job?.status, 'failed')
    assert.equal(job?.error, 'No cached file is ready for Emby sync yet')
    const flacRow = db.prepare('SELECT status, error FROM track_files WHERE id = ?').get(flac.id) as { status: string; error: string | null }
    assert.equal(flacRow.status, 'missing')
    assert.match(flacRow.error ?? '', /missing or not playable/)
  } finally {
    rmSync(oggPath, { force: true })
    globalThis.fetch = originalFetch
  }
})

test('emby sync job does not sync low quality when highest quality is missing', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `SYNC_MASTER_ONLY_${Date.now()}`
  const lowPath = path.join(appConfig.musicDir, 'Tester', 'Unknown Album', `Tester - ${songmid}.mp3`)
  const requests: string[] = []

  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  mkdirSync(path.dirname(lowPath), { recursive: true })
  writeFileSync(lowPath, 'mp3 audio')
  configureTestAccountEmby()
  try {
    const musicInfo = {
      source: 'tx' as const,
      songmid,
      name: 'Master Only Sync',
      singer: 'Tester',
      types: [{ type: 'flac' as const, size: '49 MB' }, { type: '320k' as const, size: '5 MB' }],
    }
    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: lowPath, sizeBytes: 5_000_000 })
    const created = createJob({
      type: 'sync_emby_track',
      payload: { source: 'tx', qqUin: TEST_EMBY_QQ_UIN, songmid, musicInfo },
    })

    globalThis.fetch = (async (url: string | URL | Request) => {
      requests.push(String(url))
      return Response.json({ Items: [] })
    }) as typeof fetch

    assert.equal(await processOneEmbySyncJob({
      maxAttempts: 1,
      cacheWaitMs: 0,
      scanWaitMs: 0,
    }), true)
    const job = getJob(created.id)
    assert.equal(job?.status, 'failed')
    assert.equal(job?.error, 'No cached file is ready for Emby sync yet')
    assert.deepEqual(requests, [])
  } finally {
    rmSync(lowPath, { force: true })
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

test('worker tick processes queued UM crypto refresh jobs', async () => {
  const calls: string[] = []
  const didWork = await processWorkerTick({
    scheduleCleanupResourceCacheJob: false,
    async processRefreshUmCryptoJob() {
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

test('archive track job falls back to highest reachable declared quality', async () => {
  const originalFetch = globalThis.fetch
  const originalLxMusicSourceScript = process.env.LX_MUSIC_SOURCE_SCRIPT
  const songmid = `ARCHIVE_FALLBACK_${Date.now()}`
  const requestedQualities: string[] = []
  db.prepare("DELETE FROM jobs WHERE type = 'archive_track'").run()
  try {
    process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/script/lxmusic?key=test-key'
    const musicInfo = {
      source: 'tx' as const,
      songmid,
      name: 'Archive Highest Only',
      singer: 'Archive Tester',
      types: [{ type: 'flac' as const, size: '40 MB' }, { type: '320k' as const, size: '8 MB' }],
    }
    const created = createJob({
      type: 'archive_track',
      payload: { source: 'tx' as const, songmid, musicInfo, reason: 'favorite' as const },
    })

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'script.example') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { quality?: string }
        requestedQualities.push(body.quality ?? '')
        if (body.quality === 'flac') {
          return Response.json({ error: 'flac unavailable' }, { status: 503 })
        }
        return Response.json({ url: `https://cdn.example/audio-${body.quality}.mp3` })
      }
      if (requestUrl.hostname === 'cdn.example') {
        return new Response('audio-bytes', { headers: { 'content-type': 'audio/mpeg' } })
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    }) as typeof fetch

    assert.equal(await processOneArchiveTrackJob(1), true)
    assert.deepEqual(requestedQualities, ['flac', '320k'])
    const job = getJob(created.id)
    assert.equal(job?.status, 'completed')
    const row = db.prepare(`
      SELECT tf.quality, tf.status
      FROM track_files tf
      INNER JOIN tracks t ON t.id = tf.track_id
      WHERE t.source = 'tx' AND t.songmid = ?
        AND tf.status IN ('tagging', 'ready', 'cached_raw')
      ORDER BY CASE tf.quality WHEN 'flac' THEN 0 WHEN '320k' THEN 1 WHEN '128k' THEN 2 ELSE 3 END
      LIMIT 1
    `).get(songmid) as { quality: string; status: string } | undefined
    assert.equal(row?.quality, '320k')
    assert.match(row?.status ?? '', /^(tagging|ready|cached_raw)$/)
    const failedFlac = db.prepare(`
      SELECT tf.status
      FROM track_files tf
      INNER JOIN tracks t ON t.id = tf.track_id
      WHERE t.source = 'tx' AND t.songmid = ? AND tf.quality = 'flac'
    `).get(songmid) as { status: string } | undefined
    assert.equal(failedFlac?.status, 'failed')
  } finally {
    db.prepare("DELETE FROM jobs WHERE type = 'archive_track' AND json_extract(payload_json, '$.songmid') = ?").run(songmid)
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
    globalThis.fetch = originalFetch
    if (originalLxMusicSourceScript === undefined) delete process.env.LX_MUSIC_SOURCE_SCRIPT
    else process.env.LX_MUSIC_SOURCE_SCRIPT = originalLxMusicSourceScript
  }
})

test('archive track job stops after highest reachable quality succeeds', async () => {
  const originalFetch = globalThis.fetch
  const originalLxMusicSourceScript = process.env.LX_MUSIC_SOURCE_SCRIPT
  const songmid = `ARCHIVE_HIGHEST_SUCCESS_${Date.now()}`
  const requestedQualities: string[] = []
  db.prepare("DELETE FROM jobs WHERE type = 'archive_track'").run()
  try {
    process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/script/lxmusic?key=test-key'
    const musicInfo = {
      source: 'tx' as const,
      songmid,
      name: 'Archive Highest Success',
      singer: 'Archive Tester',
      types: [{ type: 'flac' as const, size: '40 MB' }, { type: '320k' as const, size: '8 MB' }],
    }
    const created = createJob({
      type: 'archive_track',
      payload: { source: 'tx' as const, songmid, musicInfo, reason: 'favorite' as const },
    })

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'script.example') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { quality?: string }
        requestedQualities.push(body.quality ?? '')
        return Response.json({ url: `https://cdn.example/audio-${body.quality}.flac` })
      }
      if (requestUrl.hostname === 'cdn.example') {
        return new Response('audio-bytes', { headers: { 'content-type': 'audio/flac' } })
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    }) as typeof fetch

    assert.equal(await processOneArchiveTrackJob(1), true)
    assert.deepEqual(requestedQualities, ['flac'])
    assert.equal(getJob(created.id)?.status, 'completed')
  } finally {
    db.prepare("DELETE FROM jobs WHERE type = 'archive_track' AND json_extract(payload_json, '$.songmid') = ?").run(songmid)
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
    globalThis.fetch = originalFetch
    if (originalLxMusicSourceScript === undefined) delete process.env.LX_MUSIC_SOURCE_SCRIPT
    else process.env.LX_MUSIC_SOURCE_SCRIPT = originalLxMusicSourceScript
  }
})

test('UM crypto refresh job downloads latest package once and reuses local version', async () => {
  const originalFetch = globalThis.fetch
  const version = `99.0.${Date.now()}`
  const toolDir = path.join(appConfig.toolsDir, 'um-crypto', version)
  const archivePath = `/tmp/x-music-um-crypto-job-${version}.tgz`
  const fixtureDir = `/tmp/x-music-um-crypto-job-fixture-${version}`

  try {
    db.prepare("DELETE FROM jobs WHERE type = 'refresh_um_crypto'").run()
    rmSync(toolDir, { recursive: true, force: true })
    rmSync(fixtureDir, { recursive: true, force: true })
    const archive = await createUmCryptoPackage({
      fixtureDir,
      archivePath,
      loader: `
'use strict';
exports.ready = Promise.resolve(true);
exports.QMC2 = class QMC2 { decrypt() {} };
exports.detectAudioType = () => ({ audioType: 'mp3', needMore: false });
`,
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

    enqueueRefreshUmCryptoJob({ reason: 'startup' })
    assert.equal(await processWorkerTick({
      scheduleCleanupResourceCacheJob: false,
      processTagJob: async () => false,
      processEmbySyncJob: async () => false,
      processCleanupResourceCacheJob: async () => false,
    }), true)
    assert.equal(archiveDownloads, 1)

    enqueueRefreshUmCryptoJob({ reason: 'startup' })
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
    db.prepare("DELETE FROM jobs WHERE type = 'refresh_um_crypto'").run()
    globalThis.fetch = originalFetch
  }
})

async function createUmCryptoPackage(input: {
  fixtureDir: string
  archivePath: string
  loader: string
}): Promise<Buffer> {
  rmSync(input.fixtureDir, { recursive: true, force: true })
  const distDir = path.join(input.fixtureDir, 'package', 'dist')
  mkdirSync(distDir, { recursive: true })
  writeFileSync(path.join(input.fixtureDir, 'package', 'package.json'), JSON.stringify({
    name: '@unlock-music/crypto',
    version: '0.0.0',
    main: 'dist/loader-inline.js',
  }))
  writeFileSync(path.join(distDir, 'loader-inline.js'), input.loader)
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-czf', input.archivePath, '-C', input.fixtureDir, 'package'])
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)))
  })
  return readFileSync(input.archivePath)
}

test('emby sync job does not complete when scan cannot find item', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `SYNC_NOT_FOUND_${Date.now()}`
  const rawPath = `/tmp/x-music-${songmid}.mp3`
  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  writeFileSync(rawPath, 'fake audio')
  configureTestAccountEmby()
  try {
    const musicInfo = { source: 'tx' as const, songmid, name: 'Not Found Sync', singer: 'Tester' }
    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: rawPath, rawPath })
    const created = createJob({
      type: 'sync_emby_track',
      payload: { source: 'tx', qqUin: TEST_EMBY_QQ_UIN, songmid, musicInfo },
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
    globalThis.fetch = originalFetch
  }
})

test('emby sync job ignores non-matching Emby search fallback item', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `SYNC_MISMATCH_${Date.now()}`
  const rawPath = `/tmp/x-music-${songmid}.mp3`
  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  writeFileSync(rawPath, 'fake audio')
  configureTestAccountEmby()
  try {
    const musicInfo = { source: 'tx' as const, songmid, name: 'Expected Sync Song', singer: 'Expected Artist' }
    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: rawPath, rawPath })
    const created = createJob({
      type: 'sync_emby_track',
      payload: { source: 'tx', qqUin: TEST_EMBY_QQ_UIN, songmid, musicInfo },
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
    globalThis.fetch = originalFetch
  }
})

test('emby sync job fails unsupported audio containers without scanning Emby', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `SYNC_UNSUPPORTED_${Date.now()}`
  const rawPath = `/tmp/x-music-${songmid}.mgg`
  const requests: string[] = []

  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  writeFileSync(rawPath, 'fake encrypted audio')
  configureTestAccountEmby()
  try {
    const musicInfo = { source: 'tx' as const, songmid, name: 'Unsupported Sync', singer: 'Tester' }
    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: rawPath, rawPath })
    const created = createJob({
      type: 'sync_emby_track',
      payload: { source: 'tx', qqUin: TEST_EMBY_QQ_UIN, songmid, musicInfo },
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
    globalThis.fetch = originalFetch
  }
})

test('emby sync job creates or updates Emby playlist from virtual playlist ids', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `SYNC_VIRTUAL_PLAYLIST_${Date.now()}`
  const rawPath = `/tmp/x-music-${songmid}.mp3`
  const requests: Array<{ method: string; pathname: string; search: string }> = []
  const playlistQqId = `sync-virtual-playlist-${Date.now()}`
  const playlistId = `mix_${Buffer.from(JSON.stringify({ kind: 'qq-playlist', id: playlistQqId })).toString('base64url')}`

  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  db.prepare("DELETE FROM remote_mappings WHERE local_type = 'playlist' AND local_key = ? AND remote = 'emby'").run(`qq:${playlistQqId}`)
  db.prepare("DELETE FROM app_settings WHERE key = ?").run(`virtual.playlist.${playlistQqId}`)
  writeFileSync(rawPath, 'fake audio')
  configureTestAccountEmby()
  try {
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.playlist.${playlistQqId}`, JSON.stringify({
      source: 'tx',
      id: playlistQqId,
      name: 'Virtual Playlist Sync',
    }))
    const musicInfo = { source: 'tx' as const, songmid, name: 'Virtual Playlist Sync', singer: 'Tester' }
    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: rawPath, rawPath })
    const created = createJob({
      type: 'sync_emby_track',
      payload: { source: 'tx', qqUin: TEST_EMBY_QQ_UIN, songmid, playlistId, musicInfo },
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
        if (requestUrl.searchParams.get('IncludeItemTypes') === 'Playlist') {
          return Response.json({ Items: [] })
        }
        return Response.json({ Items: [{ Id: 'emby-virtual-playlist-song', Name: 'Virtual Playlist Sync', Artists: ['Tester'] }] })
      }
      if (requestUrl.pathname.endsWith('/Playlists')) {
        return Response.json({ Id: 'emby-created-virtual-playlist' })
      }
      return Response.json({}, { status: 404 })
    }) as typeof fetch

    assert.equal(await processOneEmbySyncJob(1), true)
    assert.equal(getJob(created.id)?.status, 'completed')
    assert.ok(requests.some(request => request.method === 'POST' && request.pathname.endsWith('/Playlists')))
    assert.ok(requests.some(request => request.search.includes('Name=Virtual+Playlist+Sync')))
    assert.ok(requests.some(request => request.search.includes('Ids=emby-virtual-playlist-song')))
    const mapping = db.prepare("SELECT remote_id AS remoteId FROM remote_mappings WHERE local_type = 'playlist' AND local_key = ? AND remote = 'emby'")
      .get(`qq:${playlistQqId}`) as { remoteId: string } | undefined
    assert.equal(mapping?.remoteId, 'emby-created-virtual-playlist')
  } finally {
    rmSync(rawPath, { force: true })
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(`virtual.playlist.${playlistQqId}`)
    db.prepare("DELETE FROM remote_mappings WHERE local_type = 'playlist' AND local_key = ? AND remote = 'emby'").run(`qq:${playlistQqId}`)
    globalThis.fetch = originalFetch
  }
})

test('emby sync job waits for asynchronous Emby scan results', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `SYNC_WAIT_FOUND_${Date.now()}`
  const rawPath = `/tmp/x-music-${songmid}.mp3`
  let searchCount = 0

  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  writeFileSync(rawPath, 'fake audio')
  configureTestAccountEmby()
  try {
    const musicInfo = { source: 'tx' as const, songmid, name: 'Delayed Scan Sync', singer: 'Tester' }
    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: rawPath, rawPath })
    const created = createJob({
      type: 'sync_emby_track',
      payload: { source: 'tx', qqUin: TEST_EMBY_QQ_UIN, songmid, musicInfo },
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
    globalThis.fetch = originalFetch
  }
})

test('emby sync job uploads ready media through WebDAV before scanning Emby', async () => {
  const originalFetch = globalThis.fetch
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
  configureTestAccountEmby({ webdav: true })

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
      payload: { source: 'tx', qqUin: TEST_EMBY_QQ_UIN, songmid, musicInfo },
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
        if (method === 'HEAD') return new Response(null, { status: 404 })
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
        'HEAD /dav/music/WebDAV Artist/WebDAV Album/WebDAV Artist - WebDAV Song.flac',
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
    assert.equal(existsSync(path.dirname(finalPath)), false)
    const row = db.prepare(`
      SELECT status, final_path AS finalPath, lyrics_path AS lyricsPath, cover_path AS coverPath, error
      FROM track_files
      WHERE id = ?
    `).get(trackFile.id) as {
      status: string
      finalPath?: string | null
      lyricsPath?: string | null
      coverPath?: string | null
      error?: string | null
    }
    assert.equal(row.status, 'missing')
    assert.equal(row.finalPath, null)
    assert.equal(row.lyricsPath, null)
    assert.equal(row.coverPath, null)
    assert.equal(row.error, 'Synced to Emby source and removed from local cache')
  } finally {
    rmSync(path.join(appConfig.musicDir, 'WebDAV Artist'), { recursive: true, force: true })
    globalThis.fetch = originalFetch
  }
})

test('emby sync job skips WebDAV upload when remote audio already exists', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `SYNC_WEBDAV_EXISTS_${Date.now()}`
  const relativeDir = path.join('WebDAV Existing Artist', 'WebDAV Existing Album')
  const finalPath = path.join(appConfig.musicDir, relativeDir, 'WebDAV Existing Artist - WebDAV Existing Song.flac')
  const lyricsPath = path.join(appConfig.musicDir, relativeDir, 'WebDAV Existing Artist - WebDAV Existing Song.lrc')
  const coverPath = path.join(appConfig.musicDir, relativeDir, 'cover.jpg')
  const requests: Array<{ method: string; pathname: string; search?: string; body?: string }> = []

  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  db.prepare("DELETE FROM app_settings WHERE key = 'emby.upstreamMusicLibraryMapping'").run()
  mkdirSync(path.dirname(finalPath), { recursive: true })
  writeFileSync(finalPath, 'fake audio')
  writeFileSync(lyricsPath, '[00:00.00]WebDAV Existing Song')
  writeFileSync(coverPath, 'fake cover')
  configureTestAccountEmby({ webdav: true })

  try {
    const musicInfo = { source: 'tx' as const, songmid, name: 'WebDAV Existing Song', singer: 'WebDAV Existing Artist' }
    const track = ensureTrack(musicInfo)
    const trackFile = upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath })
    db.prepare(`
      UPDATE track_files
      SET lyrics_path = ?, cover_path = ?
      WHERE id = ?
    `).run(lyricsPath, coverPath, trackFile.id)
    const created = createJob({
      type: 'sync_emby_track',
      payload: { source: 'tx', qqUin: TEST_EMBY_QQ_UIN, songmid, musicInfo },
    })

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      const method = init?.method ?? 'GET'
      if (requestUrl.hostname === 'webdav.example') {
        requests.push({
          method,
          pathname: requestUrl.pathname,
          search: requestUrl.search,
          body: init?.body ? 'body' : undefined,
        })
        return new Response(null, { status: method === 'HEAD' ? 200 : 500 })
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
        return Response.json({
          Items: [{
            Id: 'emby-webdav-existing-song',
            Name: 'WebDAV Existing Song',
            Artists: ['WebDAV Existing Artist'],
            Path: '/volume1/music/WebDAV Existing Artist/WebDAV Existing Album/WebDAV Existing Artist - WebDAV Existing Song.flac',
          }],
        })
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
        'HEAD /dav/music/WebDAV Existing Artist/WebDAV Existing Album/WebDAV Existing Artist - WebDAV Existing Song.flac',
      ],
    )
    assert.equal(existsSync(finalPath), true)
    assert.equal(existsSync(lyricsPath), true)
    assert.equal(existsSync(coverPath), true)
    const row = db.prepare(`
      SELECT status, final_path AS finalPath, lyrics_path AS lyricsPath, cover_path AS coverPath
      FROM track_files
      WHERE id = ?
    `).get(trackFile.id) as {
      status: string
      finalPath?: string | null
      lyricsPath?: string | null
      coverPath?: string | null
    }
    assert.equal(row.status, 'ready')
    assert.equal(row.finalPath, finalPath)
    assert.equal(row.lyricsPath, lyricsPath)
    assert.equal(row.coverPath, coverPath)
  } finally {
    rmSync(path.join(appConfig.musicDir, 'WebDAV Existing Artist'), { recursive: true, force: true })
    db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track' AND json_extract(payload_json, '$.songmid') = ?").run(songmid)
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
    globalThis.fetch = originalFetch
  }
})

test('emby sync job requires path match after WebDAV upload', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `SYNC_WEBDAV_PATH_ONLY_${Date.now()}`
  const relativeDir = path.join('WebDAV Artist', 'WebDAV Album')
  const finalPath = path.join(appConfig.musicDir, relativeDir, `WebDAV Artist - ${songmid}.flac`)

  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  mkdirSync(path.dirname(finalPath), { recursive: true })
  writeFileSync(finalPath, 'fake audio')
  configureTestAccountEmby({ webdav: true })

  try {
    const musicInfo = { source: 'tx' as const, songmid, name: 'Existing Low Quality Name', singer: 'WebDAV Artist' }
    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath })
    const created = createJob({
      type: 'sync_emby_track',
      payload: { source: 'tx', qqUin: TEST_EMBY_QQ_UIN, songmid, musicInfo },
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
      if (requestUrl.pathname.endsWith('/Library/Media/Updated')) return new Response(null, { status: 204 })
      if (requestUrl.pathname.endsWith('/Items')) {
        if (requestUrl.searchParams.has('Path')) return Response.json({ Items: [] })
        return Response.json({
          Items: [{ Id: 'old-name-match-song', Name: 'Existing Low Quality Name', Artists: ['WebDAV Artist'] }],
        })
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
    rmSync(path.join(appConfig.musicDir, 'WebDAV Artist'), { recursive: true, force: true })
    globalThis.fetch = originalFetch
  }
})

test('emby sync job waits for library final path before WebDAV upload', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `SYNC_WAIT_LIBRARY_${Date.now()}`
  const inboxPath = path.join(appConfig.inboxDir, `${songmid}.mp3`)
  const webdavRequests: string[] = []

  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  mkdirSync(appConfig.inboxDir, { recursive: true })
  writeFileSync(inboxPath, 'fake audio')
  configureTestAccountEmby({ webdav: true })
  try {
    const musicInfo = { source: 'tx' as const, songmid, name: 'Library Wait Sync', singer: 'Tester' }
    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: inboxPath, rawPath: inboxPath })
    const created = createJob({
      type: 'sync_emby_track',
      payload: { source: 'tx', qqUin: TEST_EMBY_QQ_UIN, songmid, musicInfo },
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
    globalThis.fetch = originalFetch
  }
})

test('emby sync preflight rejects cached raw and pathless ready rows under WebDAV sync', async () => {
  const songmid = `SYNC_PREFLIGHT_${Date.now()}`
  const inboxPath = path.join(appConfig.inboxDir, `${songmid}.mp3`)

  mkdirSync(appConfig.inboxDir, { recursive: true })
  writeFileSync(inboxPath, 'fake audio')
  configureTestAccountEmby({ webdav: true })
  try {
    const musicInfo = {
      source: 'tx' as const,
      songmid,
      name: 'Preflight Sync',
      singer: 'Tester',
      types: [{ type: 'flac', size: '40 MB' }, { type: '320k', size: '5 MB' }],
    }
    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, '320k', 'cached_raw', { rawPath: inboxPath })
    upsertTrackFileStatus(track.id, 'flac', 'ready')

    assert.equal(hasEmbySyncableCachedMedia({ source: 'tx', qqUin: TEST_EMBY_QQ_UIN, songmid, musicInfo }), false)
  } finally {
    rmSync(inboxPath, { force: true })
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
  }
})

test('emby sync preflight waits for unfinished preferred quality before WebDAV sync', async () => {
  const songmid = `SYNC_PREFLIGHT_WAIT_${Date.now()}`
  const inboxPath = path.join(appConfig.inboxDir, `${songmid}.flac`)
  const readyDir = path.join(appConfig.musicDir, 'Preflight Wait Artist', songmid)
  const readyPath = path.join(readyDir, 'Preflight Wait Artist - Preflight Wait Song.mp3')

  mkdirSync(appConfig.inboxDir, { recursive: true })
  mkdirSync(readyDir, { recursive: true })
  writeFileSync(inboxPath, 'fake flac')
  writeFileSync(readyPath, 'fake mp3')
  configureTestAccountEmby({ webdav: true })
  try {
    const musicInfo = {
      source: 'tx' as const,
      songmid,
      name: 'Preflight Wait Song',
      singer: 'Preflight Wait Artist',
      types: [{ type: 'flac' as const, size: '40 MB' }, { type: '320k' as const, size: '5 MB' }],
    }
    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, 'flac', 'cached_raw', { rawPath: inboxPath })
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: readyPath })

    assert.equal(hasEmbySyncableCachedMedia({ source: 'tx', qqUin: TEST_EMBY_QQ_UIN, songmid, musicInfo }), false)
  } finally {
    rmSync(inboxPath, { force: true })
    rmSync(path.join(appConfig.musicDir, 'Preflight Wait Artist'), { recursive: true, force: true })
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
  }
})

test('emby sync preflight does not fall back from declared pathless preferred quality under WebDAV sync', async () => {
  const songmid = `SYNC_PREFLIGHT_FALLBACK_${Date.now()}`
  const readyDir = path.join(appConfig.musicDir, 'Preflight Fallback Artist', songmid)
  const readyPath = path.join(readyDir, 'Preflight Fallback Artist - Preflight Fallback Song.mp3')

  mkdirSync(readyDir, { recursive: true })
  writeFileSync(readyPath, 'fake mp3')
  configureTestAccountEmby({ webdav: true })
  try {
    const musicInfo = {
      source: 'tx' as const,
      songmid,
      name: 'Preflight Fallback Song',
      singer: 'Preflight Fallback Artist',
      types: [{ type: 'flac' as const, size: '40 MB' }, { type: '320k' as const, size: '5 MB' }],
    }
    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, 'flac', 'ready')
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: readyPath })

    assert.equal(hasEmbySyncableCachedMedia({ source: 'tx', qqUin: TEST_EMBY_QQ_UIN, songmid, musicInfo }), false)
  } finally {
    rmSync(path.join(appConfig.musicDir, 'Preflight Fallback Artist'), { recursive: true, force: true })
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
  }
})

test('emby sync job applies local favorite state after mapping', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `SYNC_FAVORITE_${Date.now()}`
  const rawPath = `/tmp/x-music-${songmid}.mp3`
  const requests: Array<{ method: string; pathname: string }> = []

  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  writeFileSync(rawPath, 'fake audio')
  configureTestAccountEmby()
  try {
    const musicInfo = { source: 'tx' as const, songmid, name: 'Favorite Sync Song', singer: 'Favorite Artist' }
    setLocalFavoriteSynced(musicInfo, true, TEST_EMBY_QQ_UIN)
    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: rawPath, rawPath })
    const created = createJob({
      type: 'sync_emby_track',
      payload: {
        source: 'tx',
        qqUin: TEST_EMBY_QQ_UIN,
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
      if (requestUrl.pathname.includes('/FavoriteItems/')) return new Response(null, { status: 204 })
      return Response.json({}, { status: 404 })
    }) as typeof fetch

    assert.equal(await processOneEmbySyncJob(1), true)
    assert.equal(getJob(created.id)?.status, 'completed')
    assert.ok(requests.some(request => request.method === 'POST' && request.pathname.endsWith('/Users/emby-user-998001/FavoriteItems/emby-favorite-song')))
  } finally {
    rmSync(rawPath, { force: true })
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
    globalThis.fetch = originalFetch
  }
})

test('emby sync job applies local unfavorite state after mapping', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `SYNC_UNFAVORITE_${Date.now()}`
  const rawPath = `/tmp/x-music-${songmid}.mp3`
  const requests: Array<{ method: string; pathname: string }> = []

  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  writeFileSync(rawPath, 'fake audio')
  configureTestAccountEmby()
  try {
    const musicInfo = { source: 'tx' as const, songmid, name: 'Unfavorite Sync Song', singer: 'Favorite Artist' }
    setLocalFavoriteSynced(musicInfo, false, TEST_EMBY_QQ_UIN)
    const track = ensureTrack(musicInfo)
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: rawPath, rawPath })
    const created = createJob({
      type: 'sync_emby_track',
      payload: {
        source: 'tx',
        qqUin: TEST_EMBY_QQ_UIN,
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
        return Response.json({ Items: [{ Id: 'emby-unfavorite-song', Name: 'Unfavorite Sync Song', Artists: ['Favorite Artist'] }] })
      }
      if (requestUrl.pathname.includes('/FavoriteItems/')) return new Response(null, { status: 204 })
      return Response.json({}, { status: 404 })
    }) as typeof fetch

    assert.equal(await processOneEmbySyncJob(1), true)
    assert.equal(getJob(created.id)?.status, 'completed')
    assert.ok(requests.some(request => request.method === 'DELETE' && request.pathname.endsWith('/Users/emby-user-998001/FavoriteItems/emby-unfavorite-song')))
  } finally {
    rmSync(rawPath, { force: true })
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
    globalThis.fetch = originalFetch
  }
})
