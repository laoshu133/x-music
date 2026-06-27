import { handleLocalEmbyRequest } from './local-handlers'
import { proxyToUpstreamEmby } from './upstream-proxy'
import { hasUpstreamEmbyConfigured } from './auth'
import { withEmbyCors } from './cors'
import { logCompletedRequest, logFailedRequest } from '@/lib/request-log'

export async function dispatchEmbyRequest(request: Request, embyPath: string): Promise<Response> {
  const startedAt = Date.now()
  try {
    const local = await handleLocalEmbyRequest(request, embyPath)
    const response = withEmbyCors(local ?? (
      hasUpstreamEmbyConfigured()
        ? await proxyToUpstreamEmby(request, embyPath)
        : localOnlyNotFoundResponse(embyPath)
    ))
    return logCompletedRequest(request, response, startedAt, { embyPath })
  } catch (error) {
    logFailedRequest(request, startedAt, error, { embyPath })
    throw error
  }
}

function localOnlyNotFoundResponse(embyPath: string): Response {
  return Response.json({
    error: 'Not found',
    message: 'XMusic local Emby gateway did not handle this path, and no upstream Emby server is configured.',
    path: embyPath,
  }, { status: 404 })
}
