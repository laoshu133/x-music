import crypto from 'node:crypto'

export function createLocalAccessToken(account: { qqUin: string; embyUsername: string; embyPassword: string }): string {
  return crypto
    .createHash('sha256')
    .update(`mixmusic:${account.qqUin}:${account.embyUsername}:${account.embyPassword}`)
    .digest('hex')
}

export function readEmbyAccessToken(request: Request): string | undefined {
  const url = new URL(request.url)
  return request.headers.get('X-Emby-Token')
    ?? request.headers.get('X-MediaBrowser-Token')
    ?? tokenFromAuthorizationHeader(request.headers.get('X-Emby-Authorization'))
    ?? tokenFromAuthorizationHeader(request.headers.get('Authorization'))
    ?? url.searchParams.get('api_key')
    ?? url.searchParams.get('ApiKey')
    ?? undefined
}

function tokenFromAuthorizationHeader(value: string | null): string | undefined {
  if (!value) return undefined
  const quoted = value.match(/\bToken="([^"]+)"/i)?.[1]
  if (quoted) return quoted
  const unquoted = value.match(/\bToken=([^,\s]+)/i)?.[1]
  return unquoted
}
