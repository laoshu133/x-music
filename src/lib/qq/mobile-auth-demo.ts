const QQ_MUSIC_CLIENT_ID = '100497308'
const QQ_MUSIC_SCOPE = 'get_user_info,get_app_friends'

export function buildQQMobileAuthorizeUrl(input: {
  callbackUrl: string
  state: string
  useQQMusicRedirect?: boolean
}) {
  const redirectUri = input.useQQMusicRedirect
    ? `https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=${encodeURIComponent(input.callbackUrl)}`
    : input.callbackUrl
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: QQ_MUSIC_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: QQ_MUSIC_SCOPE,
    state: input.state,
    display: 'mobile',
  })
  return `https://graph.qq.com/oauth2.0/authorize?${params.toString()}`
}

export function randomAuthState() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}
