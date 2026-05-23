import { NextResponse, type NextRequest } from 'next/server'
import { logIncomingRequest } from '@/lib/request-log'

export function middleware(request: NextRequest): NextResponse {
  logIncomingRequest(request)
  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}
