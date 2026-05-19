import { handleLocalEmbyRequest } from './local-handlers'
import { proxyToUpstreamEmby } from './upstream-proxy'

export async function dispatchEmbyRequest(request: Request, embyPath: string): Promise<Response> {
  const local = await handleLocalEmbyRequest(request, embyPath)
  if (local) return local
  return proxyToUpstreamEmby(request, embyPath)
}
