import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeDbDateTime, normalizeNullableDbDateTime, normalizeOptionalDbDateTime } from '@/lib/db/time'

test('normalizes SQLite CURRENT_TIMESTAMP values as UTC ISO timestamps', () => {
  assert.equal(normalizeDbDateTime('2026-06-30 01:02:03'), '2026-06-30T01:02:03.000Z')
  assert.equal(normalizeDbDateTime('2026-06-30 01:02:03.456'), '2026-06-30T01:02:03.456Z')
})

test('leaves explicit timezone timestamps unchanged', () => {
  assert.equal(normalizeDbDateTime('2026-06-30T01:02:03.000Z'), '2026-06-30T01:02:03.000Z')
  assert.equal(normalizeDbDateTime('2026-06-30T09:02:03+08:00'), '2026-06-30T09:02:03+08:00')
})

test('normalizes optional and nullable DB timestamps', () => {
  assert.equal(normalizeOptionalDbDateTime(null), undefined)
  assert.equal(normalizeOptionalDbDateTime(undefined), undefined)
  assert.equal(normalizeNullableDbDateTime(null), null)
  assert.equal(normalizeNullableDbDateTime(undefined), null)
})
