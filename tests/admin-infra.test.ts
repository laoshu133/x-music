import assert from 'node:assert/strict'
import test from 'node:test'
import { db } from '@/lib/db'
import { deleteSetting, getEffectiveSettings, getSetting, setSetting } from '@/lib/db/settings'
import { listRequestLogs, recordRequestLog } from '@/lib/db/request-logs'
import { normalizeEmbyPath, stripOptionalEmbyPrefix } from '@/lib/emby/paths'

test('settings store persists typed values and merges effective defaults', () => {
  deleteSetting('emby.baseUrl')
  assert.equal(getSetting('emby.baseUrl'), undefined)

  setSetting('emby.baseUrl', 'http://127.0.0.1:8096')
  assert.equal(getSetting('emby.baseUrl'), 'http://127.0.0.1:8096')
  assert.equal(getEffectiveSettings().emby.baseUrl, 'http://127.0.0.1:8096')

  deleteSetting('emby.baseUrl')
})

test('request logs are listed newest first with filters', () => {
  const marker = `/test-log-${Date.now()}`
  db.prepare('DELETE FROM request_logs WHERE path = ?').run(marker)

  try {
    recordRequestLog({
      path: marker,
      method: 'GET',
      status: 200,
      durationMs: 12.4,
      source: 'local',
      startedAt: new Date().toISOString(),
    })
    recordRequestLog({
      path: marker,
      method: 'POST',
      status: 502,
      durationMs: 4,
      source: 'upstream',
      error: 'bad upstream',
      startedAt: new Date().toISOString(),
    })

    const all = listRequestLogs({ path: marker, limit: 10 })
    assert.equal(all.length, 2)
    assert.equal(all[0].status, 502)

    const upstream = listRequestLogs({ path: marker, source: 'upstream', limit: 10 })
    assert.equal(upstream.length, 1)
    assert.equal(upstream[0].error, 'bad upstream')
  } finally {
    db.prepare('DELETE FROM request_logs WHERE path = ?').run(marker)
  }
})

test('emby path helpers normalize optional emby prefix', () => {
  assert.equal(stripOptionalEmbyPrefix('/emby/Items'), '/Items')
  assert.equal(stripOptionalEmbyPrefix('/Items'), '/Items')
  assert.equal(normalizeEmbyPath(['emby', 'System', 'Info', 'Public']), '/System/Info/Public')
})
