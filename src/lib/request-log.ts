export type RequestSource = 'local' | 'upstream'

const SENSITIVE_QUERY_KEYS = new Set([
  'api_key',
  'apikey',
  'access_token',
  'token',
  'x-emby-token',
  'x-mediabrowser-token',
])

export function markRequestSource(response: Response, source: RequestSource): Response {
  response.headers.set('x-x-music-source', source)
  return response
}

export function logIncomingRequest(request: Request, details: Record<string, unknown> = {}): void {
  if (!requestLoggingEnabled()) return
  writeRequestLog({
    event: 'http_request_start',
    method: request.method,
    path: safeRequestPath(request.url),
    ip: requestIp(request),
    userAgent: trimHeader(request.headers.get('user-agent')),
    range: request.headers.has('range') ? request.headers.get('range') : undefined,
    ...details,
  })
}

export function logCompletedRequest(
  request: Request,
  response: Response,
  startedAt: number,
  details: Record<string, unknown> = {},
): Response {
  if (!requestLoggingEnabled()) return response
  writeRequestLog({
    event: 'http_request_complete',
    method: request.method,
    path: safeRequestPath(request.url),
    status: response.status,
    durationMs: Math.max(0, Date.now() - startedAt),
    source: response.headers.get('x-x-music-source') ?? undefined,
    ip: requestIp(request),
    userAgent: trimHeader(request.headers.get('user-agent')),
    range: request.headers.has('range') ? request.headers.get('range') : undefined,
    contentLength: response.headers.get('content-length') ?? undefined,
    contentRange: response.headers.get('content-range') ?? undefined,
    ...details,
  })
  return response
}

export function logFailedRequest(
  request: Request,
  startedAt: number,
  error: unknown,
  details: Record<string, unknown> = {},
): void {
  if (!requestLoggingEnabled()) return
  writeRequestLog({
    event: 'http_request_error',
    method: request.method,
    path: safeRequestPath(request.url),
    durationMs: Math.max(0, Date.now() - startedAt),
    ip: requestIp(request),
    userAgent: trimHeader(request.headers.get('user-agent')),
    error: error instanceof Error ? error.message : String(error),
    ...details,
  }, 'error')
}

export function requestLoggingEnabled(): boolean {
  const setting = process.env.X_MUSIC_REQUEST_LOGS?.trim().toLowerCase()
  if (setting && setting !== 'auto') return ['1', 'true', 'on', 'yes'].includes(setting)
  return process.env.NODE_ENV === 'production'
}

export function safeRequestPath(rawUrl: string): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return rawUrl.slice(0, 2048)
  }

  for (const key of [...url.searchParams.keys()]) {
    if (isSensitiveQueryKey(key)) url.searchParams.set(key, '[redacted]')
  }

  const value = `${url.pathname}${url.search}`
  return value.length > 2048 ? `${value.slice(0, 2045)}...` : value
}

function isSensitiveQueryKey(key: string): boolean {
  const normalized = key.trim().toLowerCase()
  return SENSITIVE_QUERY_KEYS.has(normalized) || normalized.includes('token')
}

function requestIp(request: Request): string | undefined {
  return firstHeaderValue(request.headers.get('x-forwarded-for'))
    ?? firstHeaderValue(request.headers.get('x-real-ip'))
    ?? firstHeaderValue(request.headers.get('cf-connecting-ip'))
}

function firstHeaderValue(value: string | null): string | undefined {
  const first = value?.split(',')[0]?.trim()
  return first || undefined
}

function trimHeader(value: string | null): string | undefined {
  if (!value) return undefined
  return value.length > 256 ? `${value.slice(0, 253)}...` : value
}

function writeRequestLog(payload: Record<string, unknown>, level: 'info' | 'error' = 'info'): void {
  const cleaned = Object.fromEntries(
    Object.entries({
      ts: new Date().toISOString(),
      service: 'x-music',
      ...payload,
    }).filter(([, value]) => value !== undefined && value !== ''),
  )
  console[level](JSON.stringify(cleaned))
}
