import { handleLocalEmbyRequest } from './local-handlers'
import { proxyToUpstreamEmby } from './upstream-proxy'
import { withEmbyCors } from './cors'
import { logCompletedRequest, logFailedRequest } from '@/lib/request-log'

export async function dispatchEmbyRequest(request: Request, embyPath: string): Promise<Response> {
  const startedAt = Date.now()
  try {
    const local = await handleLocalEmbyRequest(request, embyPath)
    const response = withEmbyCors(local ?? await proxyToUpstreamEmby(request, embyPath))
    return logCompletedRequest(request, response, startedAt, { embyPath })
  } catch (error) {
    logFailedRequest(request, startedAt, error, { embyPath })
    throw error
  }
}
