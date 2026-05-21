export function withEmbyCors(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  headers.set('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Emby-Authorization,X-Emby-Token,X-MediaBrowser-Token')
  headers.set('Access-Control-Expose-Headers', 'Content-Length,Content-Range,X-MediaBrowser-Token,X-Emby-Token,x-mixmusic-source')
  headers.set('Access-Control-Max-Age', '86400')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export function embyCorsPreflight(): Response {
  return withEmbyCors(new Response(null, { status: 204 }))
}
