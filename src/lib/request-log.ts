export type RequestSource = 'local' | 'upstream'

export function markRequestSource(response: Response, source: RequestSource): Response {
  response.headers.set('x-mixmusic-source', source)
  return response
}
