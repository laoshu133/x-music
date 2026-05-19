import { QQMusicError } from './http'

export type QQLoginState = {
  cookie: string
  uin: string
  encryptedUin?: string
  qqmusicKey?: string
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
  const hasSessionCookie = SESSION_COOKIE_NAMES.some((name) => parsed.has(name))

  if (!cookie || !uin || !hasSessionCookie) {
    throw new QQMusicError(
      'QQ Music login cookie is incomplete. Provide a cookie string containing uin plus qm_keyst/qqmusic_key or skey.',
      401,
      {
        actionable: 'Copy the Cookie request header from an authenticated y.qq.com request, or set QQ_MUSIC_COOKIE.',
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
    source,
  }
}

export function getQQLoginState(input?: CookieInput): QQLoginState | undefined {
  const explicitCookie = input?.cookie?.trim()
  if (explicitCookie) return buildQQLoginState(explicitCookie, 'request')

  const stored = loadStoredQQLoginState()
  if (stored) return stored

  if (process.env.QQ_MUSIC_COOKIE?.trim()) {
    return buildQQLoginState(process.env.QQ_MUSIC_COOKIE, 'env')
  }

  return undefined
}

function loadStoredQQLoginState(): QQLoginState | undefined {
  try {
    return globalThis.__mixmusicGetStoredQQLoginState?.()
  } catch {
    return undefined
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __mixmusicGetStoredQQLoginState: (() => QQLoginState | undefined) | undefined
}

export function requireQQLoginState(input?: CookieInput): QQLoginState {
  const state = getQQLoginState(input)
  if (!state) {
    throw new QQMusicError('QQ Music login cookie is required for this endpoint', 401, {
      actionable: 'Send { "cookie": "..." } to /api/account/import or configure QQ_MUSIC_COOKIE.',
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
  }
}
