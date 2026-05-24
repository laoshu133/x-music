const reservedPrefixes = ['/@player', '/%40player', '/api', '/_next', '/public', '/x-music']

export function normalizeEmbyPath(path: string[]): string {
  const pathname = `/${path.map(segment => encodeURIComponent(decodeURIComponent(segment))).join('/')}`
  return stripOptionalEmbyPrefix(pathname)
}

export function stripOptionalEmbyPrefix(pathname: string): string {
  if (pathname === '/emby') return '/'
  if (pathname.toLowerCase().startsWith('/emby/')) return pathname.slice('/emby'.length)
  return pathname
}

export function isReservedManagementPath(pathname: string): boolean {
  const lower = pathname.toLowerCase()
  return lower === '/favicon.ico' || reservedPrefixes.some(prefix => lower === prefix || lower.startsWith(`${prefix}/`))
}
