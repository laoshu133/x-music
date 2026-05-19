import { recordRequestLog, type RequestSource } from '@/lib/db/request-logs'

export async function withRequestLog(
  request: Request,
  handler: () => Promise<Response>,
  options: {
    source?: RequestSource
    path?: string
  } = {},
): Promise<Response> {
  const startedAt = new Date().toISOString()
  const started = performance.now()
  const path = options.path ?? new URL(request.url).pathname

  try {
    const response = await handler()
    recordRequestLog({
      path,
      method: request.method,
      status: response.status,
      durationMs: performance.now() - started,
      source: options.source ?? responseSource(response),
      startedAt,
    })
    return response
  } catch (error) {
    recordRequestLog({
      path,
      method: request.method,
      status: 500,
      durationMs: performance.now() - started,
      source: options.source ?? 'local',
      error: error instanceof Error ? error.message : String(error),
      startedAt,
    })
    throw error
  }
}

export function markRequestSource(response: Response, source: RequestSource): Response {
  response.headers.set('x-mixmusic-source', source)
  return response
}

function responseSource(response: Response): RequestSource {
  return response.headers.get('x-mixmusic-source') === 'upstream' ? 'upstream' : 'local'
}
