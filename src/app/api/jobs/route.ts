import { listJobs, getJobSummary } from '@/lib/jobs/status'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const status = url.searchParams.get('status') ?? undefined
  const type = url.searchParams.get('type') ?? undefined
  const limit = Number(url.searchParams.get('limit') ?? 100)

  return Response.json({
    summary: getJobSummary(),
    items: listJobs({ status, type, limit }).map(job => ({
      id: job.id,
      type: job.type,
      status: job.status,
      attempts: job.attempts,
      error: job.error,
      payload: job.payload,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    })),
  })
}
