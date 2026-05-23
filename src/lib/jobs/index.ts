import { db } from '@/lib/db'

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed'

export type JobType = 'tag_track_file' | 'sync_emby_track' | 'cleanup_resource_cache' | 'refresh_um_crypto'

export interface JobRow<TPayload = unknown> {
  id: number
  type: JobType | string
  status: JobStatus | string
  payload: TPayload
  attempts: number
  error: string | null
  nextRunAt: string | null
  createdAt: string
  updatedAt: string
}

interface JobRecord {
  id: number
  type: string
  status: string
  payload_json: string
  attempts: number
  error: string | null
  next_run_at: string | null
  created_at: string
  updated_at: string
}

export interface CreateJobInput<TPayload> {
  type: JobType
  payload: TPayload
  status?: Extract<JobStatus, 'queued' | 'running'>
}

export interface ClaimJobOptions {
  type: JobType
  maxAttempts?: number
}

export interface ClearStaleJobsOptions {
  olderThanSeconds: number
  maxAttempts?: number
}

export interface StaleRunningJobsResult {
  requeued: number
  failed: number
}

const retryBackoffSeconds = [30, 60, 180]

const parseJobRecord = <TPayload>(record: JobRecord): JobRow<TPayload> => ({
  id: record.id,
  type: record.type,
  status: record.status,
  payload: JSON.parse(record.payload_json) as TPayload,
  attempts: record.attempts,
  error: record.error,
  nextRunAt: record.next_run_at,
  createdAt: record.created_at,
  updatedAt: record.updated_at,
})

export function ensureJobsTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      next_run_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_claim
      ON jobs(type, status, next_run_at, attempts, created_at);
  `)
  try {
    db.exec('ALTER TABLE jobs ADD COLUMN next_run_at TEXT')
  } catch (error) {
    if (!String(error).includes('duplicate column name')) throw error
  }
}

export function createJob<TPayload>(input: CreateJobInput<TPayload>): JobRow<TPayload> {
  ensureJobsTable()

  const result = db.prepare(`
    INSERT INTO jobs (type, status, payload_json)
    VALUES (@type, @status, @payloadJson)
  `).run({
    type: input.type,
    status: input.status ?? 'queued',
    payloadJson: JSON.stringify(input.payload),
  })

  const job = getJob<TPayload>(Number(result.lastInsertRowid))
  if (!job) throw new Error('Failed to load created job')
  return job
}

export function getJob<TPayload = unknown>(id: number): JobRow<TPayload> | null {
  ensureJobsTable()

  const record = db.prepare('SELECT * FROM jobs WHERE id = ?')
    .get(id) as JobRecord | undefined
  return record ? parseJobRecord<TPayload>(record) : null
}

export function claimNextJob<TPayload = unknown>(
  options: ClaimJobOptions,
): JobRow<TPayload> | null {
  ensureJobsTable()

  const maxAttempts = options.maxAttempts ?? 3
  const record = db.prepare(`
    UPDATE jobs
    SET status = 'running',
        attempts = attempts + 1,
        error = NULL,
        next_run_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = (
      SELECT id
      FROM jobs
      WHERE type = @type
        AND status = 'queued'
        AND attempts < @maxAttempts
        AND (next_run_at IS NULL OR next_run_at <= CURRENT_TIMESTAMP)
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    )
    RETURNING *
  `).get({
    type: options.type,
    maxAttempts,
  }) as JobRecord | undefined

  return record ? parseJobRecord<TPayload>(record) : null
}

export function completeJob(id: number): void {
  ensureJobsTable()

  db.prepare(`
    UPDATE jobs
    SET status = 'completed',
        error = NULL,
        next_run_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({ id })
}

export function failJob(id: number, error: unknown): void {
  ensureJobsTable()

  db.prepare(`
    UPDATE jobs
    SET status = 'failed',
        error = @error,
        next_run_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({
    id,
    error: error instanceof Error ? error.message : String(error),
  })
}

export function requeueJob(id: number, error: unknown): void {
  ensureJobsTable()

  const job = getJob(id)
  const nextRunAt = retryDelaySql(job?.attempts ?? 1)

  db.prepare(`
    UPDATE jobs
    SET status = 'queued',
        error = @error,
        next_run_at = datetime('now', @delay),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({
    id,
    error: error instanceof Error ? error.message : String(error),
    delay: nextRunAt,
  })
}

export function clearStaleRunningJobs(options: ClearStaleJobsOptions): StaleRunningJobsResult {
  ensureJobsTable()
  const maxAttempts = options.maxAttempts ?? 3

  const requeued = db.prepare(`
    UPDATE jobs
    SET status = 'queued',
        error = 'Recovered stale running job',
        next_run_at = datetime('now', CASE
          WHEN attempts <= 1 THEN '+30 seconds'
          WHEN attempts = 2 THEN '+60 seconds'
          ELSE '+180 seconds'
        END),
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'running'
      AND updated_at < datetime('now', @age)
      AND attempts < @maxAttempts
  `).run({
    age: `-${Math.max(1, Math.trunc(options.olderThanSeconds))} seconds`,
    maxAttempts,
  })

  const failed = db.prepare(`
    UPDATE jobs
    SET status = 'failed',
        error = 'Cleared stale running job after max attempts',
        next_run_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'running'
      AND updated_at < datetime('now', @age)
      AND attempts >= @maxAttempts
  `).run({
    age: `-${Math.max(1, Math.trunc(options.olderThanSeconds))} seconds`,
    maxAttempts,
  })

  return { requeued: requeued.changes, failed: failed.changes }
}

export function clearJobsByStatus(status: Extract<JobStatus, 'completed' | 'failed'>): number {
  ensureJobsTable()

  const result = db.prepare(`
    DELETE FROM jobs
    WHERE status = @status
  `).run({ status })

  return result.changes
}

function retryDelaySql(attempts: number): string {
  const index = Math.max(0, Math.min(Math.trunc(attempts) - 1, retryBackoffSeconds.length - 1))
  return `+${retryBackoffSeconds[index]} seconds`
}
