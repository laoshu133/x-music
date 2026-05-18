import { NextResponse } from 'next/server'
import { getQQToplists } from '@/lib/qq'

export const runtime = 'nodejs'

export async function GET() {
  return NextResponse.json(await getQQToplists())
}
