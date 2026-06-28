import { replaceQQCookieValues, requireQQLoginState } from './account'
import { QQMusicError, qqSignedPost } from './http'

type RefreshMusickeyResponse = {
  code?: number
  req1?: {
    code?: number
    data?: {
      musickey?: string
    }
  }
}

export interface QQMusickeyRefreshResult {
  uin: string
  cookie: string
  musickey: string
  changed: boolean
  refreshedAt: string
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
    req1: {
      module: 'QQConnectLogin.LoginServer',
      method: 'QQLogin',
      param: {
        expired_in: 7776000,
        musicid: login.uin,
        musickey,
      },
    },
  }

  const data = await qqSignedPost<RefreshMusickeyResponse>(payload, {
    headers: {
      cookie: login.cookie,
      referer: 'https://y.qq.com/',
    },
  })
  const nextMusickey = data.req1?.data?.musickey
  if (!nextMusickey) {
    throw new QQMusicError('QQ Music key refresh failed', 502, {
      code: data.req1?.code ?? data.code,
      actionable: 'QQ 音乐没有返回新的 musickey，请重新完成 QQ 授权登录。',
      payload: data,
    })
  }

  const cookie = replaceQQCookieValues(login.cookie, {
    qm_keyst: nextMusickey,
    qqmusic_key: nextMusickey,
    psrf_musickey_createtime: String(Math.floor(Date.now() / 1000)),
  })

  return {
    uin: login.uin,
    cookie,
    musickey: nextMusickey,
    changed: nextMusickey !== musickey,
    refreshedAt: new Date().toISOString(),
  }
}
