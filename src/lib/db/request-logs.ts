import { db } from './index'

export type RequestSource = 'local' | 'upstream'

export interface RequestLogRecord {
  id: number
  path: string
  method: string
  status: number
  durationMs: number
  source: RequestSource
  error?: string
  startedAt: string
  completedAt: string
}

export function recordRequestLog(input: {
  path: string
  method: string
  status: number
  durationMs: number
  source: RequestSource
  error?: string
  startedAt: string
  completedAt?: string
}): void {
  db.prepare(`
    INSERT INTO request_logs (path, method, status, duration_ms, source, error, started_at, completed_at)
    VALUES (@path, @method, @status, @durationMs, @source, @error, @startedAt, @completedAt)
  `).run({
    path: input.path,
    method: input.method,
    status: input.status,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    source: input.source,
    error: input.error ?? null,
    startedAt: input.startedAt,
    completedAt: input.completedAt ?? new Date().toISOString(),
  })
}

export function listRequestLogs(options: {
  limit?: number
  offset?: number
  status?: number
  source?: RequestSource
  path?: string
} = {}): RequestLogRecord[] {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500))
  const offset = Math.max(0, options.offset ?? 0)
  const where: string[] = []
  const params: Record<string, unknown> = { limit, offset }

  if (options.status !== undefined) {
    where.push('status = @status')
    params.status = options.status
  }
  if (options.source) {
    where.push('source = @source')
    params.source = options.source
  }
  if (options.path?.trim()) {
    where.push('path LIKE @path')
    params.path = `%${options.path.trim()}%`
  }

  const sql = `
    SELECT
      id,
      path,
      method,
      status,
      duration_ms AS durationMs,
      source,
      error,
      started_at AS startedAt,
      completed_at AS completedAt
    FROM request_logs
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY completed_at DESC, id DESC
    LIMIT @limit OFFSET @offset
  `

  return db.prepare(sql).all(params) as RequestLogRecord[]
}
