import type { PagedResult, QQPlaylistInfo } from '@/lib/types'
import { formatPlayCount } from './format'
import { QQMusicError } from './http'
import { getQQLoginState } from './account'

export interface QQLoginQr {
  img: string
  ptqrtoken: number
  qrsig: string
}

export type QQLoginQrCheckResult =
  | {
      isOk: false
      refresh: boolean
      status: 'pending' | 'scanned' | 'expired'
      message: string
    }
  | {
      isOk: true
      message: string
      session: QQLoginSession
    }

export interface QQLoginSession {
  loginUin: string
  uin: string
  cookie: string
  cookieList: string[]
  cookieObject: Record<string, string>
}

type UserPlaylistRaw = {
  dissid?: string | number
  dissname?: string
  title?: string
  name?: string
  logo?: string
  imgurl?: string
  picurl?: string
  creator?: { name?: string; nick?: string }
  nickname?: string
  desc?: string
  introduction?: string
  song_cnt?: number
  song_count?: number
  listen_num?: number
  listennum?: number
  visitnum?: number
  dir_create_time?: string
  createtime?: string | number
}

const REQUEST_TIMEOUT_MS = 10000

function hash33(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash += (hash << 5) + value.charCodeAt(index)
  }
  return 2147483647 & hash
}

function getGtk(pSkey: string): number {
  let hash = 5381
  for (let index = 0; index < pSkey.length; index += 1) {
    hash += (hash << 5) + pSkey.charCodeAt(index)
  }
  return hash & 0x7fffffff
}

function getGuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
    .replace(/[xy]/g, (char) => {
      const random = (Math.random() * 16) | 0
      const value = char === 'x' ? random : (random & 0x3) | 0x8
      return value.toString(16)
    })
    .toUpperCase()
}

function parseSetCookie(setCookieHeader: string | null): string[] {
  if (!setCookieHeader) return []
  return setCookieHeader
    .split(/,(?=\s*[a-zA-Z_][\w.-]*=)/)
    .map(part => part.split(';')[0]?.trim())
    .filter((cookie): cookie is string => Boolean(cookie && cookie.includes('=') && cookie.split('=').slice(1).join('=')))
}

async function fetchWithTimeout(input: string, init: RequestInit = {}, timeout = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
      cache: 'no-store',
    })
  } finally {
    clearTimeout(timer)
  }
}

function setCookies(cookieMap: Map<string, string>, setCookieHeader: string | null) {
  for (const cookie of parseSetCookie(setCookieHeader)) {
    const [name] = cookie.split('=')
    if (name) cookieMap.set(name, cookie)
  }
}

function buildLoginSession(cookie: string): QQLoginSession {
  const cookieList = cookie.split(';').map(item => item.trim()).filter(Boolean)
  const cookieObject: Record<string, string> = {}
  for (const item of cookieList) {
    const index = item.indexOf('=')
    if (index <= 0) continue
    const key = item.slice(0, index).trim()
    const value = item.slice(index + 1).trim()
    if (key && value) cookieObject[key] = value
  }

  const loginUin = cookieObject.uin || cookieObject.qqmusic_uin || ''
  return {
    loginUin,
    uin: loginUin,
    cookie,
    cookieList,
    cookieObject,
  }
}

function extractAuthorizeUrl(body: string): string | undefined {
  return body.match(/'((?:https?):\/\/[^']+)'/)?.[1]
}

function extractPlaylists(payload: Record<string, any>): UserPlaylistRaw[] {
  const candidates = [
    payload?.data?.mydiss?.list,
    payload?.data?.mymusic,
    payload?.data?.createdDissList,
    payload?.data?.createdList,
    payload?.data?.creator?.playlist,
    payload?.data?.creator?.playlists,
    payload?.data?.playlist,
    payload?.data?.playlists,
    payload?.mydiss?.list,
    payload?.mymusic,
    payload?.createdDissList,
    payload?.createdList,
    payload?.creator?.playlist,
    payload?.creator?.playlists,
    payload?.playlist,
    payload?.playlists,
  ]

  const matched = candidates.find(Array.isArray)
  if (!matched) {
    throw new QQMusicError('QQ user playlist response did not include a playlist list', 502, {
      keys: payload && typeof payload === 'object' ? Object.keys(payload) : [],
      dataKeys: payload?.data && typeof payload.data === 'object' ? Object.keys(payload.data) : [],
    })
  }
  return matched as UserPlaylistRaw[]
}

function mapUserPlaylist(item: UserPlaylistRaw): QQPlaylistInfo {
  const id = item.dissid ?? ''
  const listenCount = item.listen_num ?? item.listennum ?? item.visitnum
  return {
    source: 'tx',
    id: String(id),
    name: item.dissname ?? item.title ?? item.name ?? '',
    author: item.creator?.name ?? item.creator?.nick ?? item.nickname,
    img: item.logo ?? item.imgurl ?? item.picurl,
    desc: item.desc ?? item.introduction,
    total: item.song_cnt ?? item.song_count,
    playCount: formatPlayCount(listenCount),
    time: typeof item.createtime === 'number' ? String(item.createtime) : item.dir_create_time ?? item.createtime,
  }
}

export async function getQQLoginQr(): Promise<QQLoginQr> {
  const url =
    'https://ssl.ptlogin2.qq.com/ptqrshow?appid=716027609&e=2&l=M&s=3&d=72&v=4&t=0.9698127522807933&daid=383&pt_3rd_aid=100497308&u1=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump'

  const response = await fetchWithTimeout(url)
  if (!response.ok) throw new QQMusicError('Failed to fetch QQ login QR', response.status)

  const image = Buffer.from(await response.arrayBuffer()).toString('base64')
  const qrsig = response.headers.get('set-cookie')?.match(/qrsig=([^;]+)/)?.[1]
  if (!qrsig) throw new QQMusicError('Failed to get qrsig from QQ login QR response', 502)

  return {
    img: `data:image/png;base64,${image}`,
    ptqrtoken: hash33(qrsig),
    qrsig,
  }
}

export async function checkQQLoginQr(input: {
  ptqrtoken: string | number
  qrsig: string
}): Promise<QQLoginQrCheckResult> {
  const { ptqrtoken, qrsig } = input
  if (!ptqrtoken || !qrsig) {
    throw new QQMusicError('Missing ptqrtoken or qrsig', 400)
  }

  try {
    const loginUrl = `https://ssl.ptlogin2.qq.com/ptqrlogin?u1=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump&ptqrtoken=${encodeURIComponent(String(ptqrtoken))}&ptredirect=0&h=1&t=1&g=1&from_ui=1&ptlang=2052&action=0-0-1711022193435&js_ver=23111510&js_type=1&login_sig=du-YS1h8*0GqVqcrru0pXkpwVg2DYw-DtbFulJ62IgPf6vfiJe*4ONVrYc5hMUNE&pt_uistyle=40&aid=716027609&daid=383&pt_3rd_aid=100497308&&o1vId=3674fc47871e9c407d8838690b355408&pt_js_version=v1.48.1`
    const loginResponse = await fetchWithTimeout(loginUrl, {
      headers: { cookie: `qrsig=${qrsig}` },
    })
    const loginText = await loginResponse.text()
    const cookieMap = new Map<string, string>()
    setCookies(cookieMap, loginResponse.headers.get('set-cookie'))

    if (!loginText.includes('登录成功')) {
      const status = parseLoginQrStatus(loginText)
      return {
        isOk: false,
        refresh: status === 'expired',
        status,
        message: status === 'expired'
          ? '二维码已失效'
          : status === 'scanned'
            ? '已扫码，请在手机上确认登录'
            : '等待扫码',
      }
    }

    const allCookies = () => Array.from(cookieMap.values()).join('; ')
    const checkSigUrl = extractAuthorizeUrl(loginText)
    if (!checkSigUrl) throw new QQMusicError('Failed to extract checkSigUrl from QQ login response', 502)

    const checkSigResponse = await fetchWithTimeout(checkSigUrl, {
      redirect: 'manual',
      headers: { cookie: allCookies() },
    })
    const checkSigCookie = checkSigResponse.headers.get('set-cookie')
    const pSkey = checkSigCookie?.match(/p_skey=([^;]+)/)?.[1]
    if (!pSkey) throw new QQMusicError('Failed to extract p_skey from QQ login response', 502)
    setCookies(cookieMap, checkSigCookie)

    const gtk = getGtk(pSkey)
    const authorizeData = new FormData()
    authorizeData.append('response_type', 'code')
    authorizeData.append('client_id', '100497308')
    authorizeData.append('redirect_uri', 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/')
    authorizeData.append('scope', 'get_user_info,get_app_friends')
    authorizeData.append('state', 'state')
    authorizeData.append('switch', '')
    authorizeData.append('from_ptlogin', '1')
    authorizeData.append('src', '1')
    authorizeData.append('update_auth', '1')
    authorizeData.append('openapi', '1010_1030')
    authorizeData.append('g_tk', gtk.toString())
    authorizeData.append('auth_time', new Date().toString())
    authorizeData.append('ui', getGuid())

    const authorizeResponse = await fetchWithTimeout('https://graph.qq.com/oauth2.0/authorize', {
      redirect: 'manual',
      method: 'POST',
      body: authorizeData,
      headers: { cookie: allCookies() },
    })
    setCookies(cookieMap, authorizeResponse.headers.get('set-cookie'))
    const location = authorizeResponse.headers.get('location')
    if (authorizeResponse.status < 300 || authorizeResponse.status >= 400 || !location) {
      throw new QQMusicError('QQ authorization did not return a redirect location', 502)
    }

    const code = location.match(/[?&]code=([^&]+)/)?.[1]
    if (!code) throw new QQMusicError('QQ authorization redirect did not include code', 502)

    const musicLoginPayload = {
      comm: {
        g_tk: gtk,
        platform: 'yqq',
        ct: 24,
        cv: 0,
      },
      req: {
        module: 'QQConnectLogin.LoginServer',
        method: 'QQLogin',
        param: { code },
      },
    }

    const musicLoginResponse = await fetchWithTimeout('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST',
      body: JSON.stringify(musicLoginPayload),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: allCookies(),
      },
    })
    setCookies(cookieMap, musicLoginResponse.headers.get('set-cookie'))

    return {
      isOk: true,
      message: '登录成功',
      session: buildLoginSession(allCookies()),
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new QQMusicError('QQ login check timed out', 504)
    }
    if (error instanceof QQMusicError) throw error
    throw new QQMusicError('QQ login check failed', 502, {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
}

function parseLoginQrStatus(loginText: string): 'pending' | 'scanned' | 'expired' {
  const code = loginText.match(/ptuiCB\('([^']+)'/)?.[1]
  if (code === '65' || loginText.includes('已失效')) return 'expired'
  if (code === '67' || loginText.includes('认证中') || loginText.includes('确认')) return 'scanned'
  return 'pending'
}

export function getQQUserAvatar(input: { k?: string; uin?: string; size?: number }) {
  const size = input.size ?? 140
  if (!Number.isFinite(size) || size <= 0) throw new QQMusicError('Invalid avatar size', 400)
  if (input.k) {
    return {
      source: 'tx' as const,
      avatarUrl: `https://thirdqq.qlogo.cn/g?b=sdk&k=${encodeURIComponent(input.k)}&s=${size}`,
      size,
    }
  }
  if (input.uin) {
    return {
      source: 'tx' as const,
      avatarUrl: `https://q.qlogo.cn/headimg_dl?dst_uin=${encodeURIComponent(input.uin)}&spec=${size}`,
      size,
    }
  }
  throw new QQMusicError('Missing k or uin', 400)
}

export async function getQQUserPlaylists(input: {
  uin?: string
  cookie?: string
  offset?: number
  limit?: number
}): Promise<PagedResult<QQPlaylistInfo> & { offset: number }> {
  const login = getQQLoginState({ cookie: input.cookie })
  const uin = input.uin ?? login?.uin
  if (!uin) throw new QQMusicError('QQ user UIN is required', 400)

  const offset = input.offset ?? 0
  const limit = input.limit ?? 30
  const params = new URLSearchParams({
    _: String(Date.now()),
    cv: '4747474',
    ct: '24',
    format: 'json',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    notice: '0',
    platform: 'yqq.json',
    needNewCode: '0',
    uin,
    g_tk_new_20200303: '0',
    g_tk: '0',
    cid: '205360838',
    userid: uin,
    reqfrom: '1',
    reqtype: '0',
    hostUin: '0',
    loginUin: uin,
  })

  const response = await fetchWithTimeout(`https://c6.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg?${params}`, {
    headers: {
      accept: 'application/json, text/plain, */*',
      referer: `https://y.qq.com/portal/profile.html?uin=${encodeURIComponent(uin)}`,
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
      ...(login?.cookie ? { cookie: login.cookie } : {}),
    },
  })
  if (!response.ok) throw new QQMusicError('QQ user playlists request failed', response.status)

  const payload = await response.json().catch((error: unknown) => {
    throw new QQMusicError('Failed to parse QQ user playlists response', response.status, {
      cause: error instanceof Error ? error.message : String(error),
    })
  }) as Record<string, any>

  if (typeof payload.code === 'number' && payload.code !== 0) {
    throw new QQMusicError('QQ user playlists request was rejected', 502, payload)
  }

  const rawList = extractPlaylists(payload)
  const list = rawList.slice(offset, offset + limit).map(mapUserPlaylist).filter(item => item.id)

  return {
    source: 'tx',
    list,
    page: Math.floor(offset / limit) + 1,
    offset,
    limit,
    total: rawList.length,
    allPage: Math.ceil(rawList.length / limit),
  }
}
