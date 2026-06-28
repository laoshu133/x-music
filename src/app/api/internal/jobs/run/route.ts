import { NextResponse } from 'next/server'
import { runJobById } from '@/lib/jobs/run'
import type { JobType } from '@/lib/jobs'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env.X_MUSIC_TASK_RUNNER_SECRET ?? process.env.TRIGGER_SECRET_KEY
  if (!secret) return NextResponse.json({ error: 'Task runner secret is not configured' }, { status: 503 })

  const authorization = request.headers.get('authorization')
  if (authorization !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => undefined) as Partial<{ jobId: unknown; type: unknown }> | undefined
  const jobId = Number(body?.jobId)
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    return NextResponse.json({ error: 'Invalid jobId' }, { status: 400 })
  }
  if (!isJobType(body?.type)) {
    return NextResponse.json({ error: 'Invalid job type' }, { status: 400 })
  }

  await runJobById({
    jobId,
    type: body.type,
  })
  return NextResponse.json({ ok: true })
}

function isJobType(value: unknown): value is JobType {
  return value === 'archive_track'
    || value === 'tag_track_file'
    || value === 'sync_emby_track'
    || value === 'cleanup_resource_cache'
    || value === 'refresh_um_crypto'
}
