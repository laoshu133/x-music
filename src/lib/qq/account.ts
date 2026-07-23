import { QQMusicError } from './http'

export type QQLoginState = {
  cookie: string
  uin: string
  encryptedUin?: string
  qqmusicKey?: string
  accessTokenExpiresAt?: string
  source: 'env' | 'request' | 'stored'
}

type CookieInput = {
  cookie?: string
}

const SESSION_COOKIE_NAMES = ['qm_keyst', 'qqmusic_key', 'p_skey', 'skey']

export function parseQQCookieText(cookieText: string): Map<string, string> {
  const cookies = new Map<string, string>()

  for (const part of cookieText.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue

    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (!key || !value) continue
    cookies.set(key, value)
  }

  return cookies
}

export function serializeQQCookies(cookies: Map<string, string>): string {
  return Array.from(cookies.entries())
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ')
}

export function replaceQQCookieValues(cookieText: string, values: Record<string, string | undefined>): string {
  const cookies = new Map<string, string>()
  for (const part of sanitizeCookieText(cookieText).split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key) cookies.set(key, value)
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) cookies.set(key, value)
  }
  return serializeQQCookies(cookies)
}

function normalizeUin(raw?: string) {
  if (!raw) return undefined
  const match = raw.match(/\d+/)
  if (!match) return undefined
  const normalized = match[0].replace(/^0+/, '')
  return normalized || match[0]
}

function sanitizeCookieText(cookieText: string) {
  return cookieText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^cookie:\s*/i, ''))
    .filter((line) => line && !line.startsWith('#'))
    .join('; ')
}

export function buildQQLoginState(cookieText: string, source: QQLoginState['source']): QQLoginState {
  const cookie = sanitizeCookieText(cookieText)
  const parsed = parseQQCookieText(cookie)
  const uin = normalizeUin(parsed.get('uin') ?? parsed.get('o_cookie') ?? parsed.get('luin'))
  const encryptedUin = parsed.get('euin') ?? parsed.get('encryptUin') ?? parsed.get('encryptedUin')
  const qqmusicKey = parsed.get('qm_keyst') ?? parsed.get('qqmusic_key')
  const accessTokenExpiresAt = parseCookieEpochSecondsValue(parsed.get('psrf_access_token_expiresAt'))
  const hasSessionCookie = SESSION_COOKIE_NAMES.some((name) => parsed.has(name))

  if (!cookie || !uin || !hasSessionCookie) {
    throw new QQMusicError(
      'QQ Music login cookie is incomplete. Provide a cookie string containing uin plus qm_keyst/qqmusic_key or skey.',
      401,
      {
        actionable: 'Copy the Cookie request header from an authenticated y.qq.com request and bind it to the current XMusic user.',
        hasUin: Boolean(uin),
        hasSessionCookie,
      },
    )
  }

  return {
    cookie,
    uin,
    encryptedUin,
    qqmusicKey,
    accessTokenExpiresAt,
    source,
  }
}

export function getQQLoginState(input?: CookieInput): QQLoginState | undefined {
  const explicitCookie = input?.cookie?.trim()
  if (explicitCookie) return buildQQLoginState(explicitCookie, 'request')
  return undefined
}

export function requireQQLoginState(input?: CookieInput): QQLoginState {
  const state = getQQLoginState(input)
  if (!state) {
    throw new QQMusicError('QQ Music login cookie is required for this endpoint', 401, {
      actionable: 'Complete QQ authorization for the current XMusic user.',
    })
  }
  return state
}

export function summarizeQQLoginState(state: QQLoginState) {
  return {
    loggedIn: true,
    source: state.source,
    uin: state.uin,
    hasEncryptedUin: Boolean(state.encryptedUin),
    hasQQMusicKey: Boolean(state.qqmusicKey),
    accessTokenExpiresAt: state.accessTokenExpiresAt,
  }
}

export function parseQQAccessTokenExpiresAt(cookieText: string): string | undefined {
  return parseCookieEpochSecondsValue(parseQQCookieText(sanitizeCookieText(cookieText)).get('psrf_access_token_expiresAt'))
}

export function parseQQMusickeyCreatedAt(cookieText: string): string | undefined {
  return parseCookieEpochSecondsValue(parseQQCookieText(sanitizeCookieText(cookieText)).get('psrf_musickey_createtime'))
}

function parseCookieEpochSecondsValue(value: string | undefined): string | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return new Date(seconds * 1000).toISOString()
}
