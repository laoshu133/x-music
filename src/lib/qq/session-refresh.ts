import { replaceQQCookieValues, requireQQLoginState } from './account'
import { zzcSign } from './crypto'
import { QQMusicError } from './http'

const REFRESH_REQ_KEY = 'music.login.LoginServer.Login'

type RefreshMusickeyResponse = {
  code?: number
  traceid?: string
  [REFRESH_REQ_KEY]?: {
    code?: number
    data?: {
      musickey?: string
      access_token?: string
      refresh_token?: string
      expired_at?: number
      keyExpiresIn?: number
      needRefreshKeyIn?: number
    }
  }
}

export interface QQMusickeyRefreshResult {
  uin: string
  cookie: string
  musickey?: string
  keyRefreshed: boolean
  tokenRefreshed: boolean
  changed: boolean
  refreshedAt: string
  upstreamCode?: number
  traceid?: string
}

export async function refreshQQMusickey(input: { cookie?: string } = {}): Promise<QQMusickeyRefreshResult> {
  const login = requireQQLoginState(input)
  const musickey = login.qqmusicKey
  if (!musickey) {
    throw new QQMusicError('QQ Music key is required to refresh authorization', 401, {
      actionable: '重新完成 QQ 授权登录，或导入包含 qm_keyst/qqmusic_key 的 Cookie。',
    })
  }

  const payload = {
    [REFRESH_REQ_KEY]: {
      module: 'music.login.LoginServer',
      method: 'Login',
      param: {
        qq: login.uin,
        musickey,
      },
    },
  }

  const data = await qqSignedGet<RefreshMusickeyResponse>(payload, login.cookie)
  const refreshData = data[REFRESH_REQ_KEY]?.data
  const nextMusickey = nonEmpty(refreshData?.musickey)
  const nextAccessToken = nonEmpty(refreshData?.access_token)
  const nextRefreshToken = nonEmpty(refreshData?.refresh_token)
  const upstreamCode = data[REFRESH_REQ_KEY]?.code ?? data.code
  if (upstreamCode !== 1000 && !nextMusickey) {
    throw new QQMusicError('QQ Music key refresh failed', 502, {
      code: upstreamCode,
      actionable: 'QQ 音乐没有返回新的 musickey，请重新完成 QQ 授权登录。',
      payload: data,
    })
  }

  const nowSeconds = Math.floor(Date.now() / 1000)
  const cookie = replaceQQCookieValues(login.cookie, {
    qm_keyst: nextMusickey,
    qqmusic_key: nextMusickey,
    psrf_musickey_createtime: nextMusickey ? String(nowSeconds) : undefined,
    psrf_qqaccess_token: nextAccessToken,
    psrf_qqrefresh_token: nextRefreshToken,
    psrf_access_token_expiresAt: nextAccessToken && refreshData?.expired_at
      ? String(nowSeconds + refreshData.expired_at)
      : undefined,
  })

  return {
    uin: login.uin,
    cookie,
    musickey: nextMusickey,
    keyRefreshed: Boolean(nextMusickey),
    tokenRefreshed: Boolean(nextAccessToken || nextRefreshToken),
    changed: Boolean(nextMusickey || nextAccessToken || nextRefreshToken),
    refreshedAt: new Date().toISOString(),
    upstreamCode,
    traceid: data.traceid,
  }
}

async function qqSignedGet<T>(body: unknown, cookie: string): Promise<T> {
  const text = JSON.stringify(body)
  const sign = zzcSign(text)
  const response = await fetch(
    `https://u6.y.qq.com/cgi-bin/musics.fcg?sign=${sign}&format=json&inCharset=utf8&outCharset=utf-8&data=${encodeURIComponent(text)}`,
    {
      headers: {
        accept: 'application/json, text/plain, */*',
        cookie,
        origin: 'https://y.qq.com',
        referer: 'https://y.qq.com/',
        'user-agent': 'QQMusic 14090508(android 12)',
      },
      cache: 'no-store',
    },
  )
  if (!response.ok) throw new QQMusicError('QQ Music key refresh request failed', response.status)
  const textBody = await response.text()
  try {
    return JSON.parse(textBody) as T
  } catch (error) {
    throw new QQMusicError('Failed to parse QQ Music key refresh response', response.status, {
      cause: error instanceof Error ? error.message : String(error),
      body: textBody.slice(0, 500),
    })
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}
