import { handleLocalEmbyRequest } from './local-handlers'
import { proxyToUpstreamEmby } from './upstream-proxy'
import { withEmbyCors } from './cors'

export async function dispatchEmbyRequest(request: Request, embyPath: string): Promise<Response> {
  const local = await handleLocalEmbyRequest(request, embyPath)
  if (local) return withEmbyCors(local)
  return withEmbyCors(await proxyToUpstreamEmby(request, embyPath))
}
