import crypto from 'node:crypto'
import {
  parseQQCookieText,
  replaceQQCookieValues,
  requireQQLoginState,
  type QQLoginState,
} from './account'
import { QQMusicError, qqPost } from './http'

type RefreshMusickeyResponse = {
  code?: number
  QQRefreshKey?: {
    code?: number
    data?: {
      musickey?: string
      access_token?: string
      refresh_token?: string
      refresh_key?: string
      openid?: string
      unionid?: string
      encryptUin?: string
      musicid?: number
      expired_at?: number
      musickeyCreateTime?: number
      keyExpiresIn?: number
      needRefreshKeyIn?: number
    }
    traceid?: string
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
  accessTokenExpiresAt?: string
}

export async function refreshQQMusickey(input: { cookie?: string } = {}): Promise<QQMusickeyRefreshResult> {
  const login = requireQQLoginState(input)
  const musickey = login.qqmusicKey
  if (!musickey) {
    throw new QQMusicError('QQ Music key is required to refresh authorization', 401, {
      actionable: '重新完成 QQ 授权登录，或导入包含 qm_keyst/qqmusic_key 的 Cookie。',
    })
  }

  const cookies = parseQQCookieText(login.cookie)
  const accessToken = cookies.get('psrf_qqaccess_token')
  const refreshToken = cookies.get('psrf_qqrefresh_token')
  const openid = cookies.get('psrf_qqopenid')
  const unionid = cookies.get('psrf_qqunionid')
  if (!accessToken || !refreshToken || !openid) {
    throw new QQMusicError('QQ Music refresh credentials are incomplete', 401, {
      code: 'QQ_AUTH_EXPIRED',
      actionable: '重新完成 QQ 授权登录，以取得 access token、refresh token 和 openid。',
      hasAccessToken: Boolean(accessToken),
      hasRefreshToken: Boolean(refreshToken),
      hasOpenid: Boolean(openid),
    })
  }

  const loginType = parseLoginType(cookies.get('tmeLoginType'))
  const expiredAt = parsePositiveInteger(cookies.get('psrf_access_token_expiresAt')) ?? 0
  const refreshKey = firstCookieValue(cookies, ['psrf_qqrefreshkey', 'psrf_qqrefresh_key']) ?? ''
  const guid = crypto.randomBytes(16).toString('hex').toUpperCase()
  const wid = BigInt(`0x${crypto.randomBytes(8).toString('hex')}`).toString()
  const payload = {
    QQRefreshKey: {
      module: 'music.login.LoginServer',
      method: 'Login',
      param: {
        access_token: accessToken,
        appid: 100497308,
        deviceName: `DESKTOP-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
        deviceType: 'Windows',
        expired_in: expiredAt,
        forceRefreshToken: 0,
        musicid: Number(login.uin),
        musickey,
        onlyNeedAccessToken: 0,
        openid,
        refresh_key: refreshKey,
        refresh_token: refreshToken,
      },
    },
    comm: {
      _channelid: '0',
      _os_version: '6.2.9200-2',
      authst: musickey,
      ct: '19',
      cv: '2192',
      guid,
      patch: '118',
      psrf_access_token_expiresAt: expiredAt,
      psrf_qqaccess_token: accessToken,
      psrf_qqopenid: openid,
      psrf_qqunionid: unionid ?? '',
      tmeAppID: 'qqmusic',
      tmeLoginType: loginType,
      uin: login.uin,
      wid,
    },
  }

  const data = await qqPost<RefreshMusickeyResponse>('https://u.y.qq.com/cgi-bin/musicu.fcg', payload, {
    headers: {
      accept: '*/*',
      cookie: login.cookie,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)',
    },
  })
  const refreshData = data.QQRefreshKey?.data
  const nextMusickey = nonEmpty(refreshData?.musickey)
  const nextAccessToken = nonEmpty(refreshData?.access_token)
  const nextRefreshToken = nonEmpty(refreshData?.refresh_token)
  const upstreamCode = data.QQRefreshKey?.code ?? data.code
  if (data.code !== 0 || data.QQRefreshKey?.code !== 0 || !nextMusickey) {
    throw new QQMusicError('QQ Music key refresh failed', 401, {
      code: upstreamCode,
      actionable: 'QQ 音乐没有返回新的 musickey，请重新完成 QQ 授权登录。',
      upstreamCode: data.code,
      response: data,
      traceid: data.QQRefreshKey?.traceid,
    })
  }

  const nowSeconds = Math.floor(Date.now() / 1000)
  const nextExpiresAt = refreshData?.expired_at && refreshData.expired_at > 0
    ? refreshData.expired_at
    : undefined
  const cookie = replaceQQCookieValues(login.cookie, {
    qm_keyst: nextMusickey,
    qqmusic_key: nextMusickey,
    psrf_musickey_createtime: String(refreshData?.musickeyCreateTime ?? nowSeconds),
    psrf_qqaccess_token: nextAccessToken,
    psrf_qqrefresh_token: nextRefreshToken,
    psrf_access_token_expiresAt: nextExpiresAt ? String(nextExpiresAt) : undefined,
    psrf_qqopenid: nonEmpty(refreshData?.openid),
    psrf_qqunionid: nonEmpty(refreshData?.unionid),
    psrf_qqrefreshkey: nonEmpty(refreshData?.refresh_key),
    euin: nonEmpty(refreshData?.encryptUin),
  })

  return {
    uin: login.uin,
    cookie,
    musickey: nextMusickey,
    keyRefreshed: Boolean(nextMusickey && nextMusickey !== musickey),
    tokenRefreshed: Boolean(nextAccessToken || nextRefreshToken),
    changed: Boolean(
      (nextMusickey && nextMusickey !== musickey)
      || (nextAccessToken && nextAccessToken !== accessToken)
      || (nextRefreshToken && nextRefreshToken !== refreshToken)
      || refreshData?.refresh_key
      || refreshData?.encryptUin,
    ),
    refreshedAt: new Date().toISOString(),
    upstreamCode,
    traceid: data.QQRefreshKey?.traceid,
    accessTokenExpiresAt: nextExpiresAt ? new Date(nextExpiresAt * 1000).toISOString() : undefined,
  }
}

function parseLoginType(value: string | undefined) {
  const parsed = Number(value)
  return parsed === 1 || parsed === 2 ? parsed : 2
}

function parsePositiveInteger(value: string | undefined) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined
}

function firstCookieValue(cookies: Map<string, string>, keys: string[]) {
  for (const key of keys) {
    const value = cookies.get(key)
    if (value) return value
  }
  return undefined
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}
