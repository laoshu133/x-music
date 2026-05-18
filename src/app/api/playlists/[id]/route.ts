import { NextResponse } from 'next/server'
import { getQQPlaylistDetail } from '@/lib/qq'

export const runtime = 'nodejs'

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  return NextResponse.json(await getQQPlaylistDetail(id))
}
