import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFileSync, rmSync } from 'node:fs'
import { db } from '@/lib/db'
import { ensureTrack, upsertTrackFileStatus } from '@/lib/cache/store'
import { processOneEmbySyncJob } from '@/lib/emby/sync-worker'
import { claimNextJob, completeJob, createJob, failJob, getJob, requeueJob } from '@/lib/jobs'
import { getJobSummary, listJobs } from '@/lib/jobs/status'

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

  assert.equal(await processOneEmbySyncJob(1), true)
  const job = getJob(created.id)
  assert.equal(job?.status, 'failed')
  assert.equal(job?.error, 'No cached file is ready for Emby sync yet')
})

test('emby sync job does not complete when scan cannot find item', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `SYNC_NOT_FOUND_${Date.now()}`
  const rawPath = `/tmp/x-music-${songmid}.mp3`
  db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track'").run()
  writeFileSync(rawPath, 'fake audio')
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

    assert.equal(await processOneEmbySyncJob(1), true)
    const job = getJob(created.id)
    assert.equal(job?.status, 'failed')
    assert.match(job?.error ?? '', /item was not found/)
  } finally {
    rmSync(rawPath, { force: true })
    globalThis.fetch = originalFetch
  }
})
