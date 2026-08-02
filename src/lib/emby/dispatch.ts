import { handleLocalEmbyRequest } from './local-handlers'
import { proxyToUpstreamEmby } from './upstream-proxy'
import { hasUpstreamEmbyConfigured } from './auth'
import { withEmbyCors } from './cors'
import { logCompletedRequest, logFailedRequest } from '@/lib/request-log'
import { markAccountActive } from '@/lib/db/accounts'
import { findAccountByAccessToken, readEmbyAccessToken } from './tokens'
import { QQAuthExpiredError, qqAuthExpiredResponse, requireActiveQQAccount } from '@/lib/qq/auth-state'
import { QQRecommendationAuthError } from '@/lib/qq/recommendations'
import { qqMusicErrorResponse } from '@/lib/qq/http'

export async function dispatchEmbyRequest(request: Request, embyPath: string): Promise<Response> {
  const startedAt = Date.now()
  try {
    const local = await handleLocalEmbyRequest(request, embyPath)
    const account = await activeAccountForRequest(request).catch((error: unknown) => {
      if (error instanceof QQAuthExpiredError) return error
      throw error
    })
    if (account instanceof QQAuthExpiredError) {
      const response = withEmbyCors(qqAuthExpiredResponse(account))
      return logCompletedRequest(request, response, startedAt, { embyPath })
    }
    const response = withEmbyCors(local ?? (
      hasUpstreamEmbyConfigured(account)
        ? await proxyToUpstreamEmby(request, embyPath)
        : localOnlyNotFoundResponse(embyPath)
    ))
    return logCompletedRequest(request, response, startedAt, { embyPath })
  } catch (error) {
    if (error instanceof QQAuthExpiredError) {
      const response = withEmbyCors(qqAuthExpiredResponse(error))
      return logCompletedRequest(request, response, startedAt, { embyPath })
    }
    if (error instanceof QQRecommendationAuthError) {
      const response = withEmbyCors(qqMusicErrorResponse(error))
      return logCompletedRequest(request, response, startedAt, { embyPath })
    }
    logFailedRequest(request, startedAt, error, { embyPath })
    return withEmbyCors(Response.json({
      error: '系统出错，请稍后重试。',
      code: 'SYSTEM_ERROR',
      actionable: '系统暂时无法完成请求，后台已记录错误。',
    }, { status: 503 }))
  }
}

function localOnlyNotFoundResponse(embyPath: string): Response {
  return Response.json({
    error: 'Not found',
    message: 'XMusic local Emby gateway did not handle this path, and no upstream Emby server is configured.',
    path: embyPath,
  }, { status: 404 })
}

async function activeAccountForRequest(request: Request) {
  const token = readEmbyAccessToken(request)
  if (!token) return undefined
  const account = findAccountByAccessToken(token)
  if (account) markAccountActive(account.userId)
  return requireActiveQQAccount(account)
}
