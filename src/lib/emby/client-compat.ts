import { readEmbyAccessToken } from './tokens'

export function readClientAccessToken(request: Request): string | undefined {
  return readEmbyAccessToken(request)
}
