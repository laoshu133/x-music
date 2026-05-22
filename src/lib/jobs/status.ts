import { db } from '@/lib/db'
import type { JobRow, JobStatus } from '@/lib/jobs'

interface JobRecord {
  id: number
  type: string
  status: string
  payload_json: string
  attempts: number
  error: string | null
  created_at: string
  updated_at: string
}

export interface JobSummary {
  total: number
  queued: number
  running: number
  completed: number
  failed: number
  byType: Record<string, Record<string, number>>
}

export function listJobs(input: {
  status?: JobStatus | string
  type?: string
  limit?: number
} = {}): JobRow[] {
  const clauses: string[] = []
  const params: Record<string, unknown> = {}
  if (input.status) {
    clauses.push('status = @status')
    params.status = input.status
  }
  if (input.type) {
    clauses.push('type = @type')
    params.type = input.type
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 200)
  const rows = db.prepare(`
    SELECT *
    FROM jobs
    ${where}
    ORDER BY
      CASE status
        WHEN 'running' THEN 0
        WHEN 'queued' THEN 1
        WHEN 'failed' THEN 2
        WHEN 'completed' THEN 3
        ELSE 4
      END,
      updated_at DESC,
      id DESC
    LIMIT @limit
  `).all({ ...params, limit }) as JobRecord[]

  return rows.map(parseJobRecord)
}

export function getJobSummary(): JobSummary {
  const rows = db.prepare(`
    SELECT type, status, COUNT(*) AS count
    FROM jobs
    GROUP BY type, status
  `).all() as Array<{ type: string; status: string; count: number }>

  const summary: JobSummary = {
    total: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    byType: {},
  }

  for (const row of rows) {
    summary.total += row.count
    if (row.status === 'queued') summary.queued += row.count
    if (row.status === 'running') summary.running += row.count
    if (row.status === 'completed') summary.completed += row.count
    if (row.status === 'failed') summary.failed += row.count
    summary.byType[row.type] ??= {}
    summary.byType[row.type]![row.status] = row.count
  }

  return summary
}

function parseJobRecord(record: JobRecord): JobRow {
  return {
    id: record.id,
    type: record.type,
    status: record.status,
    payload: JSON.parse(record.payload_json) as unknown,
    attempts: record.attempts,
    error: record.error,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  }
}
