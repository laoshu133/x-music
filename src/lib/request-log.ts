export type RequestSource = 'local' | 'upstream'

export function markRequestSource(response: Response, source: RequestSource): Response {
  response.headers.set('x-x-music-source', source)
  return response
}
