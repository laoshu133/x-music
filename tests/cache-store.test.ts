import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { ensureTrack, getPlayableTrackFile, getReadyTrackFile, insertPlayEvent, listPlayHistory, upsertTrackFileStatus } from '@/lib/cache/store'
import { cleanupResourceCache } from '@/lib/cache/resources'
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
