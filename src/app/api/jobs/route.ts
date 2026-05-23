import { listJobs, getJobDetail, getJobSummary } from '@/lib/jobs/status'
import { clearJobsByStatus } from '@/lib/jobs'
import type { JobRow, JobStatus } from '@/lib/jobs'
import { requireAdmin } from '@/lib/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const forbidden = await requireAdmin()
  if (forbidden) return forbidden

  const url = new URL(request.url)
  const status = url.searchParams.get('status') ?? undefined
  const type = url.searchParams.get('type') ?? undefined
  const id = url.searchParams.get('id')
  const limit = Number(url.searchParams.get('limit') ?? 100)

  if (id) {
    const jobId = Number(id)
    if (!Number.isInteger(jobId) || jobId <= 0) {
      return Response.json({ error: 'Invalid job id' }, { status: 400 })
    }
    const job = getJobDetail(jobId)
    if (!job) return Response.json({ error: 'Job not found' }, { status: 404 })
    return Response.json({ item: serializeJob(job) })
  }

  return Response.json({
    summary: getJobSummary(),
    items: listJobs({ status, type, limit }).map(serializeJob),
  })
}

export async function DELETE(request: Request): Promise<Response> {
  const forbidden = await requireAdmin()
  if (forbidden) return forbidden

  const url = new URL(request.url)
  const status = url.searchParams.get('status')
  if (status !== 'failed' && status !== 'completed') {
    return Response.json({ error: 'Invalid clear status' }, { status: 400 })
  }

  const deleted = clearJobsByStatus(status as Extract<JobStatus, 'completed' | 'failed'>)
  return Response.json({
    deleted,
    summary: getJobSummary(),
    items: listJobs({ limit: 100 }).map(serializeJob),
  })
}

function serializeJob(job: JobRow) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    error: job.error,
    nextRunAt: job.nextRunAt,
    payload: job.payload,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}
