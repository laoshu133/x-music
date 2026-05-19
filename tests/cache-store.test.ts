import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureTrack, getReadyTrackFile, insertPlayEvent, listPlayHistory, upsertTrackFileStatus } from '@/lib/cache/store'
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
  upsertTrackFileStatus(track.id, 'flac', 'ready', { finalPath: `/tmp/mixmusic-missing-${songmid}.flac` })
  assert.equal(getReadyTrackFile('tx', songmid, 'flac'), undefined)

  upsertTrackFileStatus(track.id, 'flac', 'failed', { error: 'upstream failed' })
  const failedReadyFile = getReadyTrackFile('tx', songmid, 'flac')
  assert.equal(failedReadyFile, undefined)
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
