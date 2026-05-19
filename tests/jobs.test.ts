import assert from 'node:assert/strict'
import test from 'node:test'
import { db } from '@/lib/db'
import { claimNextJob, completeJob, createJob, failJob, getJob, requeueJob } from '@/lib/jobs'

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
