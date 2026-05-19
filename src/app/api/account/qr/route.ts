import { NextResponse } from 'next/server'
import { getQQLoginQr, qqMusicErrorResponse } from '@/lib/qq'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    return NextResponse.json(await getQQLoginQr())
  } catch (error) {
    return qqMusicErrorResponse(error)
  }
}
