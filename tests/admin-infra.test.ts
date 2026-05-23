import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '@/lib/db'
import { deleteSetting, getEffectiveSettings, getSetting, setSetting, updateEffectiveSettings } from '@/lib/db/settings'
import { getAccountByQQ, getAccountDetail, isAdminQQ, listAccountSummaries, markAccountActive } from '@/lib/db/accounts'
import { clearQQLoginCookie, saveQQLoginCookie } from '@/lib/db/qq-session'
import { dispatchEmbyRequest } from '@/lib/emby/dispatch'
import { ensureUpstreamEmbyUserForAccount } from '@/lib/emby/auth'
import { handleLocalEmbyRequest } from '@/lib/emby/local-handlers'
import { normalizeEmbyPath, stripOptionalEmbyPrefix } from '@/lib/emby/paths'
import { proxyToUpstreamEmby } from '@/lib/emby/upstream-proxy'
import { readEmbyAccessToken } from '@/lib/emby/tokens'
import { decodeVirtualId, encodeVirtualId, songVirtualId } from '@/lib/emby/virtual-ids'
import { getFavoriteStatus, setLocalFavoriteSynced } from '@/lib/db/favorites'
import { upsertRemoteMapping } from '@/lib/db/remote-mappings'
import { updateAccountEmbyPassword } from '@/lib/db/accounts'
import { ensureTrack, insertPlayEvent } from '@/lib/cache/store'
import type { MusicInfo } from '@/lib/types'
import { syncMappedEmbyFavoriteBestEffort } from '@/lib/emby/favorites'
import { logCompletedRequest, logFailedRequest, requestLoggingEnabled, safeRequestPath } from '@/lib/request-log'

function markAccountUpstreamBound(qqUin: string, embyUserId = `emby-user-${qqUin}`, embyAccessToken?: string): void {
  db.prepare('UPDATE accounts SET emby_user_id = ?, emby_access_token = COALESCE(?, emby_access_token) WHERE qq_uin = ?').run(embyUserId, embyAccessToken ?? null, qqUin)
}

function clearUpstreamMusicLibraryCache(): void {
  db.prepare("DELETE FROM app_settings WHERE key IN ('emby.upstreamMusicLibraryMapping', 'emby.upstreamMusicLibraryIds')").run()
}

test('settings store persists typed values and merges effective defaults', () => {
  deleteSetting('qq.enabled')
  assert.equal(getSetting('qq.enabled'), undefined)

  setSetting('qq.enabled', false)
  assert.equal(getSetting('qq.enabled'), false)
  assert.equal(getEffectiveSettings().qq.enabled, false)

  deleteSetting('qq.enabled')
})

test('admin QQ env controls account permissions and summaries', () => {
  const previous = process.env.ADMIN_QQ_UINS
  try {
    process.env.ADMIN_QQ_UINS = '123456, 999777'
    db.prepare('DELETE FROM accounts WHERE qq_uin IN (?, ?)').run('123456', '999777')

    saveQQLoginCookie('uin=o123456; qm_keyst=test-key')
    saveQQLoginCookie('uin=o999777; qm_keyst=test-key')
    markAccountActive('123456')

    assert.equal(isAdminQQ('123456'), true)
    assert.equal(isAdminQQ('999777'), true)
    assert.equal(isAdminQQ('555000'), false)

    const users = listAccountSummaries().filter(user => user.qqUin === '123456' || user.qqUin === '999777')
    assert.equal(users.length, 2)
    assert.ok(users.every(user => user.isAdmin))
    assert.ok(users.find(user => user.qqUin === '123456')?.lastActiveAt)
  } finally {
    if (previous === undefined) {
      delete process.env.ADMIN_QQ_UINS
    } else {
      process.env.ADMIN_QQ_UINS = previous
    }
    db.prepare('DELETE FROM accounts WHERE qq_uin IN (?, ?)').run('123456', '999777')
    clearQQLoginCookie()
  }
})

test('account summaries include login ip and per-account playback and favorite counts', async () => {
  const song: MusicInfo = {
    source: 'tx',
    songmid: 'account-admin-song-1',
    name: 'Account Admin Song',
    singer: 'Account Singer',
  }
  db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('555123')
  db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(song.songmid)
  db.prepare("DELETE FROM account_favorites WHERE qq_uin = '555123'").run()
  try {
    saveQQLoginCookie('uin=o555123; euin=encrypted555123; qm_keyst=test-key', { loginIp: '203.0.113.9' })
    const track = ensureTrack(song)
    insertPlayEvent(track.id, '320k', '555123')
    setLocalFavoriteSynced(song, true, '555123')

    const summary = listAccountSummaries().find(user => user.qqUin === '555123')
    assert.equal(summary?.lastLoginIp, '203.0.113.9')
    assert.equal(summary?.playCount, 1)
    assert.equal(summary?.favoriteCount, 1)

    const detail = await getAccountDetail('555123')
    const recentPlays = Array.isArray(detail?.recentPlays) ? detail.recentPlays : detail?.recentPlays?.items
    assert.equal(recentPlays?.[0]?.songmid, song.songmid)
    assert.ok(detail?.favorites.items.some(item => item.songmid === song.songmid))
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('555123')
    db.prepare("DELETE FROM account_favorites WHERE qq_uin = '555123'").run()
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(song.songmid)
    clearQQLoginCookie()
  }
})

test('request logging defaults to production only and logs only non-success responses', () => {
  const previous = process.env.X_MUSIC_REQUEST_LOGS
  const previousMode = process.env.X_MUSIC_REQUEST_LOG_MODE
  const previousNodeEnv = process.env.NODE_ENV
  const originalInfo = console.info
  const originalError = console.error
  const messages: string[] = []
  const errorMessages: string[] = []
  try {
    delete process.env.X_MUSIC_REQUEST_LOGS
    assert.equal(requestLoggingEnabled(), false)
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true, enumerable: true, writable: true })
    assert.equal(requestLoggingEnabled(), true)
    Object.defineProperty(process.env, 'NODE_ENV', { value: previousNodeEnv, configurable: true, enumerable: true, writable: true })

    process.env.X_MUSIC_REQUEST_LOGS = 'true'
    assert.equal(requestLoggingEnabled(), true)
    assert.equal(
      safeRequestPath('http://local/Items/1?api_key=secret&Token=abc&plain=ok'),
      '/Items/1?api_key=%5Bredacted%5D&Token=%5Bredacted%5D&plain=ok',
    )

    console.info = (message?: unknown) => {
      messages.push(String(message))
    }
    console.error = (message?: unknown) => {
      errorMessages.push(String(message))
    }
    const request = new Request('http://local/Audio/item/stream?api_key=secret', {
      headers: {
        'user-agent': 'test-agent',
        range: 'bytes=0-',
        'x-forwarded-for': '203.0.113.10, 10.0.0.1',
      },
    })
    logCompletedRequest(request, new Response(null, {
      status: 206,
      headers: {
        'x-x-music-source': 'local',
        'content-range': 'bytes 0-9/100',
      },
    }), Date.now() - 5, { route: '/Audio' })

    assert.equal(messages.length, 0)

    logCompletedRequest(request, new Response(null, {
      status: 404,
      headers: {
        'x-x-music-source': 'upstream',
        'content-length': '0',
        'server-timing': 'emby-upstream;dur=12',
      },
    }), Date.now() - 5, { route: '/Audio' })

    assert.equal(messages.length, 2)
    const requestPayload = JSON.parse(messages[0]!) as Record<string, unknown>
    assert.equal(requestPayload.event, 'http_request')
    assert.equal(requestPayload.status, undefined)
    assert.equal(requestPayload.path, '/Audio/item/stream?api_key=%5Bredacted%5D')
    assert.equal(requestPayload.ip, '203.0.113.10')
    assert.equal(requestPayload.range, 'bytes=0-')

    const responsePayload = JSON.parse(messages[1]!) as Record<string, unknown>
    assert.equal(responsePayload.event, 'http_response')
    assert.equal(responsePayload.status, 404)
    assert.equal(responsePayload.path, '/Audio/item/stream?api_key=%5Bredacted%5D')
    assert.equal(responsePayload.source, 'upstream')
    assert.equal(responsePayload.serverTiming, 'emby-upstream;dur=12')

    logFailedRequest(request, Date.now() - 5, new Error('boom'), { route: '/Audio' })
    assert.equal(errorMessages.length, 2)
    const failedRequestPayload = JSON.parse(errorMessages[0]!) as Record<string, unknown>
    assert.equal(failedRequestPayload.event, 'http_request')
    assert.equal(failedRequestPayload.path, '/Audio/item/stream?api_key=%5Bredacted%5D')
    const failedResponsePayload = JSON.parse(errorMessages[1]!) as Record<string, unknown>
    assert.equal(failedResponsePayload.event, 'http_response')
    assert.equal(failedResponsePayload.status, 500)
    assert.equal(failedResponsePayload.error, 'boom')
  } finally {
    console.info = originalInfo
    console.error = originalError
    if (previous === undefined) {
      delete process.env.X_MUSIC_REQUEST_LOGS
    } else {
      process.env.X_MUSIC_REQUEST_LOGS = previous
    }
    if (previousMode === undefined) {
      delete process.env.X_MUSIC_REQUEST_LOG_MODE
    } else {
      process.env.X_MUSIC_REQUEST_LOG_MODE = previousMode
    }
    Object.defineProperty(process.env, 'NODE_ENV', { value: previousNodeEnv, configurable: true, enumerable: true, writable: true })
  }
})

test('catch-all route returns friendly 404 for browser navigation to unknown paths', async () => {
  const route = await import('@/app/[...path]/route')
  const response = await route.GET(new Request('http://local/xxx', {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'sec-fetch-mode': 'navigate',
    },
  }), { params: Promise.resolve({ path: ['xxx'] }) })

  assert.equal(response.status, 404)
  assert.match(response.headers.get('content-type') ?? '', /text\/html/)
  const body = await response.text()
  assert.match(body, /页面不存在/)
  assert.match(body, /\/xxx/)
})

test('QQ login creates a per-account Emby gateway account', () => {
  db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('123456')
  try {
    const saved = saveQQLoginCookie('uin=o123456; qm_keyst=test-key')
    const account = getAccountByQQ('123456')
    assert.equal(saved.uin, '123456')
    assert.equal(account?.embyUsername, 'QQ123456')
    assert.equal(typeof account?.embyPassword, 'string')
    assert.ok(account?.embyPassword && account.embyPassword.length >= 16)
    assert.equal(saved.emby.generatedPassword, account?.embyPassword)

    const savedAgain = saveQQLoginCookie('uin=o123456; qm_keyst=next-key')
    assert.equal(savedAgain.emby.generatedPassword, undefined)
    assert.equal(getAccountByQQ('123456')?.embyPassword, account?.embyPassword)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('123456')
    clearQQLoginCookie()
  }
})

test('upstream emby account creation uses QQ-prefixed username and restricts access to music library', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999019')
    saveQQLoginCookie('uin=o999019; qm_keyst=test-key')
    const account = getAccountByQQ('999019')
    assert.ok(account)

    const requests: Array<{ url: URL; init?: RequestInit; body?: Record<string, unknown> }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
      requests.push({ url: requestUrl, init, body })

      if (requestUrl.pathname.endsWith('/Users')) return Response.json([])
      if (requestUrl.pathname.endsWith('/Users/New')) return Response.json({ Id: 'emby-user-999019', Name: body?.Name })
      if (requestUrl.pathname.endsWith('/Users/emby-user-999019') && init?.method !== 'POST') {
        return Response.json({
          Id: 'emby-user-999019',
          Name: 'QQ999019',
          Policy: { EnableAllFolders: false, EnabledFolders: ['music-library-guid'] },
        })
      }
      if (requestUrl.pathname.endsWith('/Library/VirtualFolders')) {
        return Response.json([
          { Guid: 'music-library-guid', ItemId: 'music-folder-id', Name: '音乐', CollectionType: 'music' },
          { ItemId: 'movie-folder-id', Name: '电影', CollectionType: 'movies' },
        ])
      }
      if (requestUrl.pathname.endsWith('/Users/emby-user-999019/Policy')) return new Response(null, { status: 204 })
      if (requestUrl.pathname.endsWith('/Users/AuthenticateByName')) return Response.json({ AccessToken: 'upstream-token-999019' })

      return Response.json({ error: 'unexpected request' }, { status: 500 })
    }) as typeof fetch

    const updated = await ensureUpstreamEmbyUserForAccount(account)
    assert.equal(updated.embyUserId, 'emby-user-999019')
    assert.equal(updated.embyAccessToken, 'upstream-token-999019')
    assert.equal(getAccountByQQ('999019')?.embyUserId, 'emby-user-999019')
    assert.equal(getAccountByQQ('999019')?.embyAccessToken, 'upstream-token-999019')

    const createUser = requests.find(request => request.url.pathname.endsWith('/Users/New'))
    assert.equal(createUser?.body?.Name, 'QQ999019')

    const policy = requests.find(request => request.url.pathname.endsWith('/Users/emby-user-999019/Policy'))?.body
    assert.ok(policy)
    assert.equal(policy.EnableAllFolders, false)
    assert.deepEqual(policy.EnabledFolders, ['music-library-guid', 'music-folder-id'])
    assert.equal(policy.EnableAllChannels, false)
    assert.deepEqual(policy.EnabledChannels, [])
    assert.equal(policy.EnableRemoteControlOfOtherUsers, false)
    assert.equal(policy.EnableSharedDeviceControl, false)
    assert.equal(policy.EnableContentDeletion, true)
    assert.deepEqual(policy.EnableContentDeletionFromFolders, ['music-library-guid', 'music-folder-id'])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999019')
    clearUpstreamMusicLibraryCache()
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('upstream emby account policy falls back to collection folder music id', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999021')
    saveQQLoginCookie('uin=o999021; qm_keyst=test-key')
    const account = getAccountByQQ('999021')
    assert.ok(account)

    const requests: Array<{ url: URL; init?: RequestInit; body?: Record<string, unknown> }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
      requests.push({ url: requestUrl, init, body })

      if (requestUrl.pathname.endsWith('/Users')) return Response.json([])
      if (requestUrl.pathname.endsWith('/Users/New')) return Response.json({ Id: 'emby-user-999021', Name: body?.Name })
      if (requestUrl.pathname.endsWith('/Users/emby-user-999021') && init?.method !== 'POST') {
        return Response.json({
          Id: 'emby-user-999021',
          Name: 'QQ999021',
          Policy: { EnableAllFolders: false, EnabledFolders: ['music-library-guid'] },
        })
      }
      if (requestUrl.pathname.endsWith('/Library/VirtualFolders')) {
        return Response.json([
          { Name: 'Music', CollectionType: 'music' },
          { ItemId: 'movie-folder-id', Name: '电影', CollectionType: 'movies' },
        ])
      }
      if (requestUrl.pathname.endsWith('/Items') && requestUrl.searchParams.get('IncludeItemTypes') === 'CollectionFolder') {
        return Response.json({
          Items: [
            { Guid: 'music-library-guid', Id: '11696830', Name: 'Music', Type: 'CollectionFolder', CollectionType: 'music' },
            { Id: 'movie-folder-id', Name: 'Movies', Type: 'CollectionFolder', CollectionType: 'movies' },
          ],
        })
      }
      if (requestUrl.pathname.endsWith('/Users/emby-user-999021/Policy')) return new Response(null, { status: 204 })
      if (requestUrl.pathname.endsWith('/Users/AuthenticateByName')) return Response.json({ AccessToken: 'upstream-token-999021' })

      return Response.json({ error: 'unexpected request' }, { status: 500 })
    }) as typeof fetch

    await ensureUpstreamEmbyUserForAccount(account)

    const policy = requests.find(request => request.url.pathname.endsWith('/Users/emby-user-999021/Policy'))?.body
    assert.ok(policy)
    assert.equal(policy.EnableAllFolders, false)
    assert.deepEqual(policy.EnabledFolders, ['music-library-guid', '11696830'])
    assert.equal(policy.EnableContentDeletion, true)
    assert.deepEqual(policy.EnableContentDeletionFromFolders, ['music-library-guid', '11696830'])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999021')
    clearUpstreamMusicLibraryCache()
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('upstream emby account binding fails when policy verification misses music library', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999024')
    saveQQLoginCookie('uin=o999024; qm_keyst=test-key')
    const account = getAccountByQQ('999024')
    assert.ok(account)

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined

      if (requestUrl.pathname.endsWith('/Users')) return Response.json([])
      if (requestUrl.pathname.endsWith('/Users/New')) return Response.json({ Id: 'emby-user-999024', Name: body?.Name })
      if (requestUrl.pathname.endsWith('/Users/emby-user-999024') && init?.method !== 'POST') {
        return Response.json({
          Id: 'emby-user-999024',
          Name: 'QQ999024',
          Policy: { EnableAllFolders: false, EnabledFolders: [] },
        })
      }
      if (requestUrl.pathname.endsWith('/Library/VirtualFolders')) {
        return Response.json([{ Guid: 'music-library-guid', ItemId: 'music-folder-id', Name: '音乐', CollectionType: 'music' }])
      }
      if (requestUrl.pathname.endsWith('/Users/emby-user-999024/Policy')) return new Response(null, { status: 204 })

      return Response.json({ error: 'unexpected request' }, { status: 500 })
    }) as typeof fetch

    await assert.rejects(
      ensureUpstreamEmbyUserForAccount(account),
      /policy verification failed/,
    )
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999024')
    clearUpstreamMusicLibraryCache()
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('upstream emby account binding normalizes existing username and reapplies restricted policy', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999020')
    saveQQLoginCookie('uin=o999020; qm_keyst=test-key')
    db.prepare('UPDATE accounts SET emby_user_id = ?, emby_username = ? WHERE qq_uin = ?')
      .run('emby-user-999020', 'QQ999020', '999020')
    const account = getAccountByQQ('999020')
    assert.ok(account)

    const requests: Array<{ url: URL; init?: RequestInit; body?: Record<string, unknown> }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
      requests.push({ url: requestUrl, init, body })

      if (requestUrl.pathname.endsWith('/Users/emby-user-999020') && init?.method !== 'POST') {
        return Response.json({
          Id: 'emby-user-999020',
          Name: '999020',
          Policy: { EnableAllFolders: false, EnabledFolders: ['music-library-guid'] },
        })
      }
      if (requestUrl.pathname.endsWith('/Users/emby-user-999020') && init?.method === 'POST') {
        return new Response(null, { status: 204 })
      }
      if (requestUrl.pathname.endsWith('/Library/VirtualFolders')) {
        return Response.json({ Items: [{ Guid: 'music-library-guid', Id: 'music-folder-id', Name: 'Music', CollectionType: 'music' }] })
      }
      if (requestUrl.pathname.endsWith('/Users/emby-user-999020/Policy')) return new Response(null, { status: 204 })
      if (requestUrl.pathname.endsWith('/Users/AuthenticateByName')) return Response.json({ AccessToken: 'upstream-token-999020' })

      return Response.json({ error: 'unexpected request' }, { status: 500 })
    }) as typeof fetch

    const updated = await ensureUpstreamEmbyUserForAccount(account)
    assert.equal(updated.embyUserId, 'emby-user-999020')

    const rename = requests.find(request => request.url.pathname.endsWith('/Users/emby-user-999020') && request.init?.method === 'POST')
    assert.equal(rename?.body?.Name, 'QQ999020')

    const policy = requests.find(request => request.url.pathname.endsWith('/Users/emby-user-999020/Policy'))?.body
    assert.ok(policy)
    assert.equal(policy.EnableAllFolders, false)
    assert.deepEqual(policy.EnabledFolders, ['music-library-guid', 'music-folder-id'])
    assert.equal(policy.EnableAllChannels, false)
    assert.equal(policy.EnableRemoteControlOfOtherUsers, false)
    assert.equal(policy.EnableSharedDeviceControl, false)
    assert.equal(policy.EnableContentDeletion, true)
    assert.deepEqual(policy.EnableContentDeletionFromFolders, ['music-library-guid', 'music-folder-id'])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999020')
    clearUpstreamMusicLibraryCache()
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('emby path helpers normalize optional emby prefix', () => {
  assert.equal(stripOptionalEmbyPrefix('/emby/Items'), '/Items')
  assert.equal(stripOptionalEmbyPrefix('/Items'), '/Items')
  assert.equal(normalizeEmbyPath(['emby', 'System', 'Info', 'Public']), '/System/Info/Public')
})

test('local emby public info supports original emby routes', async () => {
  const response = await handleLocalEmbyRequest(new Request('http://local/System/Info/Public'), '/System/Info/Public')
  assert.equal(response?.status, 200)
  const payload = await response!.json()
  assert.equal(payload.ServerName, 'XMusic')
})

test('emby dispatch adds cors headers for external players', async () => {
  const response = await dispatchEmbyRequest(new Request('http://local/System/Info/Public'), '/System/Info/Public')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*')
})

test('upstream proxy strips decoded-body compression headers', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ Items: [] }), {
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'br',
        'content-length': '5',
      },
    })) as typeof fetch

    const response = await proxyToUpstreamEmby(new Request('http://local/Items?Limit=1'), '/Items')

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/json')
    assert.equal(response.headers.get('content-encoding'), null)
    assert.equal(response.headers.get('content-length'), null)
    assert.deepEqual(await response.json(), { Items: [] })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('upstream proxy omits empty request body for body-capable methods', async () => {
  const originalFetch = globalThis.fetch
  try {
    let forwardedInit: RequestInit | undefined
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      forwardedInit = init
      return Response.json({ ok: true })
    }) as typeof fetch

    const response = await proxyToUpstreamEmby(new Request('http://local/Sessions/Capabilities/Full', {
      method: 'POST',
    }), '/Sessions/Capabilities/Full')

    assert.equal(response.status, 200)
    assert.equal(forwardedInit?.method, 'POST')
    assert.equal(forwardedInit?.body, undefined)
    assert.equal((forwardedInit as RequestInit & { duplex?: string } | undefined)?.duplex, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('emby token parser accepts ampcast authorization header', () => {
  const request = new Request('http://local/emby/System/Endpoint', {
    headers: {
      'X-Emby-Authorization': 'MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="abc123"',
    },
  })
  assert.equal(readEmbyAccessToken(request), 'abc123')
  assert.equal(readEmbyAccessToken(new Request('http://local/emby/System/Endpoint?Token=abc123')), 'abc123')
})

test('runtime config updates do not accept upstream Emby or LX fields', () => {
  updateEffectiveSettings({ qqEnabled: false })
  const settings = getEffectiveSettings().emby
  assert.equal(settings.baseUrl, process.env.EMBY_UPSTREAM_URL)
  assert.equal(settings.apiKey, process.env.EMBY_API_KEY)
  assert.equal(getEffectiveSettings().qq.enabled, false)

  deleteSetting('qq.enabled')
})

test('local emby authenticate by name succeeds and rejects bad credentials', async () => {
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999001')
    saveQQLoginCookie('uin=o999001; qm_keyst=test-key')
    markAccountUpstreamBound('999001')
    const account = getAccountByQQ('999001')
    assert.ok(account)

    const ok = await handleLocalEmbyRequest(new Request('http://local/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), '/Users/AuthenticateByName')
    assert.equal(ok?.status, 200)
    const payload = await ok!.json()
    assert.equal(payload.User.Name, account.embyUsername)
    assert.equal(payload.ServerId, 'x-music')
    assert.equal(typeof payload.AccessToken, 'string')
    assert.ok(payload.AccessToken.length > 20)

    const bad = await handleLocalEmbyRequest(new Request('http://local/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: 'local-user', Pw: 'bad-pass' }),
    }), '/Users/AuthenticateByName')
    assert.equal(bad?.status, 401)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999001')
    clearQQLoginCookie()
  }
})

test('local emby authenticate accepts mobile-compatible casing and form credentials', async () => {
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999025')
    saveQQLoginCookie('uin=o999025; qm_keyst=test-key')
    markAccountUpstreamBound('999025')
    const account = getAccountByQQ('999025')
    assert.ok(account)

    const lowerJson = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: account.embyUsername.toLowerCase(), password: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(lowerJson?.status, 200)
    assert.equal((await lowerJson!.json()).User.Name, account.embyUsername)

    const lowerPath = await handleLocalEmbyRequest(new Request('http://local/emby/Users/authenticatebyname', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ Username: account.embyUsername.toLowerCase(), Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/authenticatebyname'))
    assert.equal(lowerPath?.status, 200)
    assert.equal((await lowerPath!.json()).User.Name, account.embyUsername)

    const form = new URLSearchParams({
      Username: account.embyUsername.toLowerCase(),
      Password: account.embyPassword,
    })
    const formResponse = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(formResponse?.status, 200)
    assert.equal((await formResponse!.json()).User.Name, account.embyUsername)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999025')
    clearQQLoginCookie()
  }
})

test('account emby password can be manually changed', () => {
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999026')
    saveQQLoginCookie('uin=o999026; qm_keyst=test-key')
    const account = getAccountByQQ('999026')
    assert.ok(account)

    const updated = updateAccountEmbyPassword(account.qqUin, ' manual-player-password ')
    assert.equal(updated?.embyPassword, 'manual-player-password')
    assert.equal(getAccountByQQ('999026')?.embyPassword, 'manual-player-password')
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999026')
    clearQQLoginCookie()
  }
})

test('local emby authenticate reports upstream binding failures', async () => {
  const originalFetch = globalThis.fetch
  const originalConsoleError = console.error
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999023')
    saveQQLoginCookie('uin=o999023; qm_keyst=test-key')
    const account = getAccountByQQ('999023')
    assert.ok(account)

    console.error = () => undefined
    globalThis.fetch = (async () => Response.json({ error: 'upstream unavailable' }, { status: 500 })) as typeof fetch

    const response = await handleLocalEmbyRequest(new Request('http://local/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), '/Users/AuthenticateByName')
    assert.equal(response?.status, 502)
    assert.deepEqual(await response!.json(), {
      error: 'Upstream Emby account binding failed',
      actionable: 'Check EMBY_UPSTREAM_URL, EMBY_API_KEY, and whether a music library exists in upstream Emby.',
    })
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999023')
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
    console.error = originalConsoleError
  }
})

test('local emby user views returns music library for ampcast startup', async () => {
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999002')
    saveQQLoginCookie('uin=o999002; qm_keyst=test-key')
    markAccountUpstreamBound('999002')
    const account = getAccountByQQ('999002')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()

    const views = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Views`, {
        headers: {
          'X-Emby-Authorization': `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", DeviceId="test-device", Token="${authPayload.AccessToken}"`,
        },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Views`),
    )
    assert.equal(views.status, 200)
    assert.equal(views.headers.get('Access-Control-Allow-Origin'), '*')
    const payload = await views.json()
    assert.equal(payload.TotalRecordCount, 1)
    assert.equal(payload.Items[0].CollectionType, 'music')
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999002')
    clearQQLoginCookie()
  }
})

test('local emby music library item list reads upstream without virtual parent id', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999003')
    saveQQLoginCookie('uin=o999003; qm_keyst=test-key')
    markAccountUpstreamBound('999003')
    const account = getAccountByQQ('999003')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()

    const upstreamRequests: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      upstreamRequests.push(String(url))
      return Response.json({
        Items: [{ Id: 'emby-song-1', Name: 'Emby Song', Type: 'Audio' }],
        TotalRecordCount: 1,
      })
    }) as typeof fetch

    const items = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=x-music-music&SearchTerm=&Limit=500&StartIndex=0`, {
        headers: {
          'X-Emby-Authorization': `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`,
        },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    globalThis.fetch = originalFetch

    assert.equal(items.status, 200)
    const payload = await items.json()
    assert.deepEqual(payload, {
      Items: [{ Id: 'emby-song-1', Name: 'Emby Song', Type: 'Audio' }],
      TotalRecordCount: 1,
    })
    assert.equal(upstreamRequests.length, 1)
    assert.equal(new URL(upstreamRequests[0]!).searchParams.has('ParentId'), false)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999003')
    clearUpstreamMusicLibraryCache()
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('local emby music library parent maps to cached upstream music library id', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999022')
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run('emby.upstreamMusicLibraryIds', JSON.stringify(['11696830']))
    saveQQLoginCookie('uin=o999022; qm_keyst=test-key')
    markAccountUpstreamBound('999022')
    const account = getAccountByQQ('999022')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()

    const upstreamRequests: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      upstreamRequests.push(String(url))
      return Response.json({
        Items: [{ Id: 'emby-song-1', Name: 'Emby Song', Type: 'Audio' }],
        TotalRecordCount: 1,
      })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=x-music-music&Limit=500&StartIndex=0`, {
        headers: {
          'X-Emby-Authorization': `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`,
        },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )

    assert.equal(response.status, 200)
    assert.equal(upstreamRequests.length, 1)
    assert.equal(new URL(upstreamRequests[0]!).searchParams.get('ParentId'), '11696830')
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999022')
    clearUpstreamMusicLibraryCache()
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('local emby search merges upstream Emby items with QQ virtual songs', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999005')
    saveQQLoginCookie('uin=o999005; qm_keyst=test-key')
    markAccountUpstreamBound('999005')
    const account = getAccountByQQ('999005')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()

    const upstreamRequests: string[] = []
    let releaseUpstream: (() => void) | undefined
    let resolveUpstreamStarted: (() => void) | undefined
    let resolveQQStarted: (() => void) | undefined
    let upstreamReleased = false
    let qqStartedBeforeUpstreamReleased = false
    const upstreamStarted = new Promise<void>(resolve => {
      resolveUpstreamStarted = resolve
    })
    const qqStarted = new Promise<void>(resolve => {
      resolveQQStarted = resolve
    })
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        qqStartedBeforeUpstreamReleased = !upstreamReleased
        resolveQQStarted?.()
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              body: {
                item_song: [{
                  id: 123,
                  mid: 'qq-song-1',
                  title: 'QQ Song',
                  interval: 188,
                  singer: [{ name: 'QQ Artist', mid: 'qq-artist-1' }],
                  album: { name: 'QQ Album', mid: 'qq-album-1' },
                  file: { media_mid: 'qq-media-1', size_320mp3: 1024 },
                }],
              },
              meta: { estimate_sum: 1 },
            },
          },
        })
      }

      upstreamRequests.push(String(url))
      await new Promise<void>(resolve => {
        releaseUpstream = () => {
          upstreamReleased = true
          resolve()
        }
        resolveUpstreamStarted?.()
      })
      return Response.json({
        Items: [
          { Id: 'emby-folder-1', Name: 'Emby Folder', Type: 'CollectionFolder' },
          { Id: 'emby-song-1', Name: 'Emby Song', Type: 'Audio', Artists: ['Emby Artist'] },
        ],
        TotalRecordCount: 2,
      })
    }) as typeof fetch

    const responsePromise = dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=x-music-music&SearchTerm=song&Limit=50&StartIndex=0`, {
        headers: {
          'X-Emby-Authorization': `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`,
        },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    try {
      await Promise.race([
        qqStarted,
        new Promise((_, reject) => setTimeout(() => reject(new Error('QQ search did not start before upstream search completed')), 1000)),
      ])
      assert.equal(qqStartedBeforeUpstreamReleased, true)
    } finally {
      await Promise.race([
        upstreamStarted,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Upstream search did not start')), 1000)),
      ])
      releaseUpstream?.()
    }
    const response = await responsePromise

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.TotalRecordCount, 2)
    assert.deepEqual(payload.Items.map((item: { Name: string }) => item.Name), ['Emby Song', 'QQ Song'])
    assert.equal(upstreamRequests.length, 1)
    assert.equal(new URL(upstreamRequests[0]!).searchParams.has('ParentId'), false)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999005')
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('local emby search caps QQ song expansion for large client pages', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999016')
    saveQQLoginCookie('uin=o999016; qm_keyst=test-key')
    markAccountUpstreamBound('999016')
    const account = getAccountByQQ('999016')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()

    const qqPageSizes: number[] = []
    const upstreamRequests: string[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
        const page = Number(body.req?.param?.page_num ?? 1)
        const pageSize = Number(body.req?.param?.num_per_page ?? 0)
        qqPageSizes.push(pageSize)
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              body: {
                item_song: Array.from({ length: pageSize }, (_, index) => {
                  const id = (page - 1) * pageSize + index + 1
                  return {
                    id,
                    mid: `qq-search-page-${id}`,
                    title: `QQ Search ${id}`,
                    interval: 188,
                    singer: [{ name: 'QQ Artist', mid: 'qq-artist-1' }],
                    album: { name: 'QQ Album', mid: 'qq-album-1' },
                    file: { media_mid: `qq-media-${id}`, size_320mp3: 1024 },
                  }
                }),
              },
              meta: { estimate_sum: 250 },
            },
          },
        })
      }

      upstreamRequests.push(String(url))
      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=x-music-music&SearchTerm=song&Limit=250&StartIndex=0`, {
        headers: {
          'X-Emby-Authorization': `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`,
        },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.Items.length, 50)
    assert.equal(payload.TotalRecordCount, 50)
    assert.deepEqual(qqPageSizes, [50])
    assert.equal(new URL(upstreamRequests[0]!).searchParams.get('Limit'), '50')
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999016')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key LIKE 'virtual.song.qq-search-page-%'").run()
    globalThis.fetch = originalFetch
  }
})

test('musiver audio search stays bounded even when client requests 500 media-source items', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999018')
    saveQQLoginCookie('uin=o999018; qm_keyst=test-key')
    markAccountUpstreamBound('999018')
    const account = getAccountByQQ('999018')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()

    let qqRequests = 0
    const upstreamRequests: string[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        qqRequests += 1
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
        const pageSize = Number(body.req?.param?.num_per_page ?? 0)
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              body: {
                item_song: Array.from({ length: pageSize }, (_, index) => ({
                  id: index + 1,
                  mid: `qq-musiver-search-${index + 1}`,
                  title: `QQ Musiver Search ${index + 1}`,
                  interval: 188,
                  singer: [{ name: 'QQ Artist', mid: 'qq-artist-1' }],
                  album: { name: 'QQ Album', mid: 'qq-album-1' },
                  file: { media_mid: `qq-media-${index + 1}`, size_320mp3: 1024 },
                })),
              },
              meta: { estimate_sum: 500 },
            },
          },
        })
      }

      upstreamRequests.push(String(url))
      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&Recursive=true&Fields=AudioInfo%2CSortName%2CMediaSources%2CDateCreated%2CProductionYear%2CCanDelete&StartIndex=0&Limit=500&ImageTypeLimit=1&EnableImageTypes=Primary&SortBy=DateCreated&SortOrder=Descending&SearchTerm=${encodeURIComponent('花好月圆')}`, {
        headers: {
          authorization: `MediaBrowser Client="Musiver", Version="1.3.9", Token="${authPayload.AccessToken}"`,
          'user-agent': 'musiver/1.3.9 (Macintosh)',
        },
      }),
      stripOptionalEmbyPrefix(`/Users/${authPayload.User.Id}/Items`),
    )

    assert.equal(response.status, 200)
    const text = await response.text()
    const payload = JSON.parse(text)
    assert.equal(payload.Items.length, 50)
    assert.equal(payload.TotalRecordCount, 50)
    assert.equal(qqRequests, 1)
    assert.equal(new URL(upstreamRequests[0]!).searchParams.get('Limit'), '50')
    assert.match(response.headers.get('server-timing') ?? '', /emby-upstream;dur=\d+/)
    assert.match(response.headers.get('server-timing') ?? '', /qq-search;dur=\d+/)
    assert.ok(Buffer.byteLength(text) < 500_000)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999018')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key LIKE 'virtual.song.qq-musiver-search-%'").run()
    globalThis.fetch = originalFetch
  }
})

test('local emby playlist search merges upstream and QQ playlists', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999006')
    saveQQLoginCookie('uin=o999006; qm_keyst=test-key')
    markAccountUpstreamBound('999006')
    const account = getAccountByQQ('999006')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()

    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'c.y.qq.com') {
        return Response.json({
          code: 0,
          data: {
            list: [{
              dissid: 'qq-playlist-1',
              dissname: 'QQ Playlist',
              creator: { name: 'QQ User' },
              song_count: 12,
            }],
            sum: 1,
          },
        })
      }

      return Response.json({
        Items: [{ Id: 'emby-playlist-1', Name: 'Emby Playlist', Type: 'Playlist' }],
        TotalRecordCount: 1,
      })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Playlist&ParentId=x-music-music&SearchTerm=playlist&Limit=10&StartIndex=0`, {
        headers: {
          'X-Emby-Authorization': `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`,
        },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.TotalRecordCount, 2)
    assert.deepEqual(payload.Items.map((item: { Name: string }) => item.Name), ['Emby Playlist', 'QQ Playlist'])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999006')
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('local emby playlist search caps QQ playlist expansion for large client pages', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999017')
    saveQQLoginCookie('uin=o999017; qm_keyst=test-key')
    markAccountUpstreamBound('999017')
    const account = getAccountByQQ('999017')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()

    const qqPageSizes: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'c.y.qq.com') {
        const pageNo = Number(requestUrl.searchParams.get('page_no') ?? 0)
        const pageSize = Number(requestUrl.searchParams.get('num_per_page') ?? 0)
        qqPageSizes.push(`${pageNo}:${pageSize}`)
        return Response.json({
          code: 0,
          data: {
            list: Array.from({ length: pageSize }, (_, index) => {
              const id = pageNo * pageSize + index + 1
              return {
                dissid: `qq-playlist-page-${id}`,
                dissname: `QQ Playlist ${id}`,
                creator: { name: 'QQ User' },
                song_count: 12,
              }
            }),
            sum: 120,
          },
        })
      }

      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Playlist&ParentId=x-music-music&SearchTerm=playlist&Limit=120&StartIndex=0`, {
        headers: {
          'X-Emby-Authorization': `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`,
        },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.Items.length, 50)
    assert.equal(payload.TotalRecordCount, 50)
    assert.deepEqual(qqPageSizes, ['0:50'])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999017')
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('musiver items delete converts batch post to upstream delete calls', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999033')
    saveQQLoginCookie('uin=o999033; qm_keyst=test-key')
    markAccountUpstreamBound('999033', 'emby-user-999033', 'upstream-user-token-999033')
    const account = getAccountByQQ('999033')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="Musiver", Version="1.3.9", Token="${authPayload.AccessToken}"`

    const upstreamDeletes: Array<{ pathname: string; method?: string; ids: string | null }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.pathname === '/Items/Delete' && init?.method === 'POST') {
        assert.equal(requestUrl.searchParams.get('api_key'), 'upstream-user-token-999033')
        assert.equal(new Headers(init.headers).get('X-Emby-Token'), 'upstream-user-token-999033')
        upstreamDeletes.push({ pathname: requestUrl.pathname, method: init.method, ids: requestUrl.searchParams.get('Ids') })
        return new Response(null, { status: 204 })
      }
      return Response.json({ error: 'unexpected upstream request' }, { status: 500 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request('http://local/emby/Items/Delete?Ids=11740781,11740782', {
        method: 'POST',
        headers: { authorization: authHeader },
      }),
      stripOptionalEmbyPrefix('/emby/Items/Delete'),
    )
    assert.equal(response.status, 204)
    assert.deepEqual(upstreamDeletes, [
      { pathname: '/Items/Delete', method: 'POST', ids: '11740781,11740782' },
    ])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999033')
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('musiver item delete converts single delete to upstream batch delete', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999035')
    saveQQLoginCookie('uin=o999035; qm_keyst=test-key')
    markAccountUpstreamBound('999035', 'emby-user-999035', 'upstream-user-token-999035')
    const account = getAccountByQQ('999035')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="Musiver", Version="1.3.9", Token="${authPayload.AccessToken}"`

    const upstreamDeletes: Array<{ pathname: string; method?: string; ids: string | null }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.pathname === '/Items/Delete' && init?.method === 'POST') {
        assert.equal(requestUrl.searchParams.get('api_key'), 'upstream-user-token-999035')
        assert.equal(new Headers(init.headers).get('X-Emby-Token'), 'upstream-user-token-999035')
        upstreamDeletes.push({ pathname: requestUrl.pathname, method: init.method, ids: requestUrl.searchParams.get('Ids') })
        return new Response(null, { status: 204 })
      }
      return Response.json({ error: 'unexpected upstream request' }, { status: 500 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request('http://local/emby/Items/11740781', {
        method: 'DELETE',
        headers: { authorization: authHeader },
      }),
      stripOptionalEmbyPrefix('/emby/Items/11740781'),
    )
    assert.equal(response.status, 204)
    assert.deepEqual(upstreamDeletes, [
      { pathname: '/Items/Delete', method: 'POST', ids: '11740781' },
    ])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999035')
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('musiver items delete reports upstream delete failures', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999038')
    saveQQLoginCookie('uin=o999038; qm_keyst=test-key')
    markAccountUpstreamBound('999038')
    const account = getAccountByQQ('999038')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="Musiver", Version="1.3.9", Token="${authPayload.AccessToken}"`

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.pathname === '/Items/Delete' && init?.method === 'POST') {
        return new Response("Value cannot be null. (Parameter 'user')", { status: 400 })
      }
      return Response.json({ error: 'unexpected upstream request' }, { status: 500 })
    }) as typeof fetch

    const deleted = await dispatchEmbyRequest(
      new Request('http://local/emby/Items/Delete?Ids=11740781', {
        method: 'POST',
        headers: { authorization: authHeader },
      }),
      stripOptionalEmbyPrefix('/emby/Items/Delete'),
    )
    assert.equal(deleted.status, 502)
    const payload = await deleted.json()
    assert.equal(payload.error, '无法删除 Emby 歌单')
    assert.match(payload.message, /上游 Emby 拒绝/)
    assert.match(payload.detail, /Items\/Delete/)
    assert.match(payload.detail, /user/)
    assert.match(payload.actionable, /删除权限/)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999038')
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('musiver items delete clears virtual items locally', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999034')
    saveQQLoginCookie('uin=o999034; qm_keyst=test-key')
    markAccountUpstreamBound('999034')
    const account = getAccountByQQ('999034')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="Musiver", Version="1.3.9", Token="${authPayload.AccessToken}"`
    const virtualId = encodeVirtualId({ kind: 'qq-playlist', id: 'virtual-delete-playlist' })

    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run('virtual.playlist.virtual-delete-playlist', JSON.stringify({
      source: 'tx',
      id: 'virtual-delete-playlist',
      name: 'Virtual Delete Playlist',
    }))

    const upstreamRequests: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      upstreamRequests.push(String(url))
      return Response.json({ error: 'virtual delete leaked upstream' }, { status: 500 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Items/Delete?Ids=${encodeURIComponent(virtualId)}`, {
        method: 'POST',
        headers: { authorization: authHeader },
      }),
      stripOptionalEmbyPrefix('/emby/Items/Delete'),
    )
    assert.equal(response.status, 204)
    const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get('virtual.playlist.virtual-delete-playlist')
    assert.equal(row, undefined)
    assert.deepEqual(upstreamRequests, [])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999034')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('virtual.playlist.virtual-delete-playlist')
    globalThis.fetch = originalFetch
  }
})

test('musiver single item delete clears virtual items locally', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999036')
    saveQQLoginCookie('uin=o999036; qm_keyst=test-key')
    markAccountUpstreamBound('999036')
    const account = getAccountByQQ('999036')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="Musiver", Version="1.3.9", Token="${authPayload.AccessToken}"`
    const virtualId = encodeVirtualId({ kind: 'qq-playlist', id: 'virtual-single-delete-playlist' })

    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run('virtual.playlist.virtual-single-delete-playlist', JSON.stringify({
      source: 'tx',
      id: 'virtual-single-delete-playlist',
      name: 'Virtual Single Delete Playlist',
    }))

    const upstreamRequests: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      upstreamRequests.push(String(url))
      return Response.json({ error: 'virtual delete leaked upstream' }, { status: 500 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Items/${encodeURIComponent(virtualId)}`, {
        method: 'DELETE',
        headers: { authorization: authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Items/${encodeURIComponent(virtualId)}`),
    )
    assert.equal(response.status, 204)
    const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get('virtual.playlist.virtual-single-delete-playlist')
    assert.equal(row, undefined)
    assert.deepEqual(upstreamRequests, [])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999036')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('virtual.playlist.virtual-single-delete-playlist')
    globalThis.fetch = originalFetch
  }
})

test('musiver virtual favorite item delete is handled locally without leaking to upstream Emby', async () => {
  const originalFetch = globalThis.fetch
  const songmid = '003aAYrm3GE0Ac'
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999039')
    saveQQLoginCookie('uin=o999039; euin=encrypted999039; qm_keyst=test-key')
    markAccountUpstreamBound('999039')
    const account = getAccountByQQ('999039')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="Musiver", Version="1.3.9", Token="${authPayload.AccessToken}"`

    const song = {
      source: 'tx' as const,
      songmid,
      name: 'Favorite Delete Song',
      singer: 'Favorite Artist',
      albumName: 'Favorite Album',
      albumId: 'favorite-album-1',
      raw: { songId: 449205, songType: 0 },
    }
    setLocalFavoriteSynced(song, true)
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({ song }))

    const upstreamRequests: string[] = []
    const qqFavoriteWrites: Array<{ method: string; param: unknown }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
        qqFavoriteWrites.push({
          method: body.req?.method,
          param: body.req?.param,
        })
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              retCode: 0,
              result: {
                dirId: 201,
                songlist: [{ backendSongId: 449205, songId: 449205, songType: 0 }],
              },
            },
          },
        })
      }
      upstreamRequests.push(String(url))
      return Response.json({ error: 'virtual favorite mutation leaked upstream' }, { status: 500 })
    }) as typeof fetch

    const virtualId = songVirtualId(song)
    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/FavoriteItems/${encodeURIComponent(virtualId)}`, {
        method: 'DELETE',
        headers: { authorization: authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/FavoriteItems/${encodeURIComponent(virtualId)}`),
    )

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ItemId, virtualId)
    assert.equal(payload.IsFavorite, false)
    assert.equal(payload.PlaybackPositionTicks, 0)
    assert.deepEqual(upstreamRequests, [])
    assert.equal(qqFavoriteWrites.length, 1)
    assert.equal(qqFavoriteWrites[0].method, 'DelSonglist')
    assert.equal(getFavoriteStatus('tx', songmid).favorite, false)
    assert.equal(getFavoriteStatus('tx', songmid).syncState, 'synced')
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999039')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)
    globalThis.fetch = originalFetch
  }
})

test('musiver virtual favorite item delete succeeds when virtual song cache is missing', async () => {
  const originalFetch = globalThis.fetch
  const songmid = '003FdJZH1wljMU'
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999040')
    saveQQLoginCookie('uin=o999040; euin=encrypted999040; qm_keyst=test-key')
    markAccountUpstreamBound('999040')
    const account = getAccountByQQ('999040')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="Musiver", Version="1.3.9", Token="${authPayload.AccessToken}"`

    const song = {
      source: 'tx' as const,
      songmid,
      name: 'Missing Virtual Cache Song',
      singer: 'Favorite Artist',
      raw: { songId: 551307, songType: 0 },
    }
    setLocalFavoriteSynced(song, true)
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)

    const upstreamRequests: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      upstreamRequests.push(String(url))
      return Response.json({ error: 'virtual favorite mutation leaked upstream' }, { status: 500 })
    }) as typeof fetch

    const virtualId = songVirtualId(song)
    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/FavoriteItems/${encodeURIComponent(virtualId)}`, {
        method: 'DELETE',
        headers: { authorization: authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/FavoriteItems/${encodeURIComponent(virtualId)}`),
    )

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ItemId, virtualId)
    assert.equal(payload.IsFavorite, false)
    assert.deepEqual(upstreamRequests, [])
    assert.equal(getFavoriteStatus('tx', songmid).favorite, false)
    assert.equal(getFavoriteStatus('tx', songmid).syncState, 'pending')
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999040')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)
    globalThis.fetch = originalFetch
  }
})

test('mobile emby virtual favorite item post delete suffix is handled as unfavorite', async () => {
  const originalFetch = globalThis.fetch
  const songmid = '003FdJZH1wljMU'
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999043')
    saveQQLoginCookie('uin=o999043; euin=encrypted999043; qm_keyst=test-key')
    markAccountUpstreamBound('999043')
    const account = getAccountByQQ('999043')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="Musiver", Version="1.3.9", Token="${authPayload.AccessToken}"`

    const song = {
      source: 'tx' as const,
      songmid,
      name: 'Mobile Favorite Delete Song',
      singer: 'Favorite Artist',
      raw: { songId: 551307, songType: 0 },
    }
    setLocalFavoriteSynced(song, true)
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)

    const upstreamRequests: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      upstreamRequests.push(String(url))
      return Response.json({ error: 'virtual favorite mutation leaked upstream' }, { status: 500 })
    }) as typeof fetch

    const virtualId = songVirtualId(song)
    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/FavoriteItems/${encodeURIComponent(virtualId)}/Delete`, {
        method: 'POST',
        headers: { authorization: authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/FavoriteItems/${encodeURIComponent(virtualId)}/Delete`),
    )

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ItemId, virtualId)
    assert.equal(payload.IsFavorite, false)
    assert.deepEqual(upstreamRequests, [])
    assert.equal(getFavoriteStatus('tx', songmid).favorite, false)
    assert.equal(getFavoriteStatus('tx', songmid).syncState, 'pending')
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999043')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)
    globalThis.fetch = originalFetch
  }
})

test('local emby favorite list hides QQ songs locally marked unfavorite', async () => {
  const originalFetch = globalThis.fetch
  const songmid = 'qq-favorite-hidden-after-delete'
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999044')
    saveQQLoginCookie('uin=o999044; euin=encrypted999044; qm_keyst=test-key')
    markAccountUpstreamBound('999044')
    const account = getAccountByQQ('999044')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="Musiver", Version="1.3.9", Token="${authPayload.AccessToken}"`

    const song = {
      source: 'tx' as const,
      songmid,
      name: 'Hidden After Delete Song',
      singer: 'Favorite Artist',
      raw: { songId: 771122, songType: 0 },
    }
    setLocalFavoriteSynced(song, true, '999044')
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
        if (body.req?.method === 'DelSonglist') {
          return Response.json({ code: 1, req: { code: 1 } }, { status: 200 })
        }
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              songlist: [{
                id: 771122,
                mid: songmid,
                title: 'Hidden After Delete Song',
                interval: 188,
                singer: [{ name: 'Favorite Artist', mid: 'favorite-artist' }],
                album: { name: 'Favorite Album', mid: 'favorite-album' },
                file: { media_mid: 'favorite-media', size_320mp3: 1024 },
              }],
              total_song_num: 1,
            },
          },
        })
      }

      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const virtualId = songVirtualId(song)
    const deleted = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/FavoriteItems/${encodeURIComponent(virtualId)}/Delete`, {
        method: 'POST',
        headers: { authorization: authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/FavoriteItems/${encodeURIComponent(virtualId)}/Delete`),
    )
    assert.equal(deleted.status, 200)
    assert.equal(getFavoriteStatus('tx', songmid).favorite, false)
    assert.equal(getFavoriteStatus('tx', songmid).syncState, 'pending')

    const favorites = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=x-music-music&Filters=IsFavorite&Limit=100&StartIndex=0`, {
        headers: { authorization: authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(favorites.status, 200)
    const payload = await favorites.json()
    assert.equal(payload.TotalRecordCount, 0)
    assert.deepEqual(payload.Items, [])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999044')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)
    globalThis.fetch = originalFetch
  }
})

test('virtual favorite mutation syncs mapped Emby favorite state', async () => {
  const originalFetch = globalThis.fetch
  const songmid = 'qq-favorite-syncs-emby'
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999045')
    saveQQLoginCookie('uin=o999045; euin=encrypted999045; qm_keyst=test-key')
    markAccountUpstreamBound('999045', 'emby-user-999045', 'emby-user-token-999045')
    const account = getAccountByQQ('999045')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="Musiver", Version="1.3.9", Token="${authPayload.AccessToken}"`

    const song = {
      source: 'tx' as const,
      songmid,
      name: 'Syncs Emby Favorite Song',
      singer: 'Favorite Artist',
      raw: { songId: 881122, songType: 0 },
    }
    setLocalFavoriteSynced(song, true, '999045')
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({ song }))
    upsertRemoteMapping({
      localType: 'track',
      localKey: `tx:${songmid}`,
      remote: 'emby',
      remoteId: 'emby-mapped-favorite-song',
      raw: song,
    })

    const embyFavoriteWrites: Array<{ pathname: string; method: string }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              retCode: 0,
              result: { dirId: 201, songlist: [{ backendSongId: 881122, songId: 881122, songType: 0 }] },
            },
          },
        })
      }
      if (requestUrl.pathname.endsWith('/Users/emby-user-999045/FavoriteItems/emby-mapped-favorite-song')) {
        embyFavoriteWrites.push({ pathname: requestUrl.pathname, method: init?.method ?? 'GET' })
        return Response.json({ IsFavorite: false, ItemId: 'emby-mapped-favorite-song' })
      }
      return Response.json({ error: 'unexpected upstream request' }, { status: 500 })
    }) as typeof fetch

    const virtualId = songVirtualId(song)
    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/FavoriteItems/${encodeURIComponent(virtualId)}/Delete`, {
        method: 'POST',
        headers: { authorization: authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/FavoriteItems/${encodeURIComponent(virtualId)}/Delete`),
    )

    assert.equal(response.status, 200)
    assert.deepEqual(embyFavoriteWrites, [{
      pathname: '/Users/emby-user-999045/FavoriteItems/emby-mapped-favorite-song',
      method: 'DELETE',
    }])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999045')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)
    db.prepare("DELETE FROM remote_mappings WHERE local_type = 'track' AND local_key = ? AND remote = 'emby'").run(`tx:${songmid}`)
    globalThis.fetch = originalFetch
  }
})

test('mapped Emby favorite helper syncs favorite state inline', async () => {
  const originalFetch = globalThis.fetch
  const songmid = 'api-favorite-syncs-emby'
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999046')
    saveQQLoginCookie('uin=o999046; euin=encrypted999046; qm_keyst=test-key')
    markAccountUpstreamBound('999046', 'emby-user-999046', 'emby-user-token-999046')

    const song = {
      source: 'tx' as const,
      songmid,
      name: 'API Syncs Emby Favorite Song',
      singer: 'Favorite Artist',
      raw: { songId: 991122, songType: 0 },
    }
    upsertRemoteMapping({
      localType: 'track',
      localKey: `tx:${songmid}`,
      remote: 'emby',
      remoteId: 'emby-api-mapped-favorite-song',
      raw: song,
    })

    const embyFavoriteWrites: Array<{ pathname: string; method: string }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              retCode: 0,
              result: { dirId: 201, songlist: [{ backendSongId: 991122, songId: 991122, songType: 0 }] },
            },
          },
        })
      }
      if (requestUrl.pathname.endsWith('/Users/emby-user-999046/FavoriteItems/emby-api-mapped-favorite-song')) {
        embyFavoriteWrites.push({ pathname: requestUrl.pathname, method: init?.method ?? 'GET' })
        return Response.json({ IsFavorite: false, ItemId: 'emby-api-mapped-favorite-song' })
      }
      return Response.json({ error: 'unexpected upstream request' }, { status: 500 })
    }) as typeof fetch

    const account = getAccountByQQ('999046')
    assert.ok(account)
    const payload = await syncMappedEmbyFavoriteBestEffort(account, song, false)
    assert.equal(payload.attempted, true)
    assert.equal(payload.synced, true)
    assert.deepEqual(embyFavoriteWrites, [{
      pathname: '/Users/emby-user-999046/FavoriteItems/emby-api-mapped-favorite-song',
      method: 'DELETE',
    }])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999046')
    clearQQLoginCookie()
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)
    db.prepare("DELETE FROM remote_mappings WHERE local_type = 'track' AND local_key = ? AND remote = 'emby'").run(`tx:${songmid}`)
    globalThis.fetch = originalFetch
  }
})

test('musiver virtual favorite item delete returns success when no local song record exists', async () => {
  const originalFetch = globalThis.fetch
  const songmid = 'missing-local-favorite-song'
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999041')
    saveQQLoginCookie('uin=o999041; euin=encrypted999041; qm_keyst=test-key')
    markAccountUpstreamBound('999041')
    const account = getAccountByQQ('999041')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="Musiver", Version="1.3.9", Token="${authPayload.AccessToken}"`

    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)

    const upstreamRequests: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      upstreamRequests.push(String(url))
      return Response.json({ error: 'virtual favorite mutation leaked upstream' }, { status: 500 })
    }) as typeof fetch

    const virtualId = encodeVirtualId({ kind: 'qq-song', songmid })
    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/FavoriteItems/${encodeURIComponent(virtualId)}`, {
        method: 'DELETE',
        headers: { authorization: authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/FavoriteItems/${encodeURIComponent(virtualId)}`),
    )

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ItemId, virtualId)
    assert.equal(payload.IsFavorite, false)
    assert.deepEqual(upstreamRequests, [])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999041')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)
    globalThis.fetch = originalFetch
  }
})

test('musiver virtual favorite item post returns emby user data payload', async () => {
  const originalFetch = globalThis.fetch
  const songmid = 'favorite-post-song'
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999042')
    saveQQLoginCookie('uin=o999042; euin=encrypted999042; qm_keyst=test-key')
    markAccountUpstreamBound('999042')
    const account = getAccountByQQ('999042')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="Musiver", Version="1.3.9", Token="${authPayload.AccessToken}"`

    const song = {
      source: 'tx' as const,
      songmid,
      name: 'Favorite Post Song',
      singer: 'Favorite Artist',
      raw: { songId: 665544, songType: 0 },
    }
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({ song }))

    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              retCode: 0,
              result: {
                dirId: 201,
                songlist: [{ backendSongId: 665544, songId: 665544, songType: 0 }],
              },
            },
          },
        })
      }
      return Response.json({ error: 'virtual favorite mutation leaked upstream' }, { status: 500 })
    }) as typeof fetch

    const virtualId = songVirtualId(song)
    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/FavoriteItems/${encodeURIComponent(virtualId)}`, {
        method: 'POST',
        headers: { authorization: authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/FavoriteItems/${encodeURIComponent(virtualId)}`),
    )

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ItemId, virtualId)
    assert.equal(payload.IsFavorite, true)
    assert.equal(payload.PlaybackPositionTicks, 0)
    assert.equal(getFavoriteStatus('tx', songmid).favorite, true)
    assert.equal(getFavoriteStatus('tx', songmid).syncState, 'synced')
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999042')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)
    globalThis.fetch = originalFetch
  }
})

test('local emby favorites merge QQ songs without deriving favorite albums', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999011')
    saveQQLoginCookie('uin=o999011; euin=encrypted999011; qm_keyst=test-key')
    markAccountUpstreamBound('999011')
    const account = getAccountByQQ('999011')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`

    let qqFavoriteRequests = 0
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        qqFavoriteRequests += 1
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              songlist: [{
                id: 123,
                mid: 'qq-favorite-song-1',
                title: 'QQ Favorite Song',
                interval: 188,
                singer: [{ name: 'QQ Artist', mid: 'qq-artist-1' }],
                album: { name: 'QQ Favorite Album', mid: 'qq-album-1', time_public: '2024-01-01' },
                file: { media_mid: 'qq-media-1', size_320mp3: 1024 },
              }],
              total_song_num: 1,
            },
          },
        })
      }

      return Response.json({
        Items: [{ Id: 'emby-favorite-album-1', Name: 'Emby Favorite Album', Type: 'MusicAlbum' }],
        TotalRecordCount: 1,
      })
    }) as typeof fetch

    const songs = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=x-music-music&Filters=IsFavorite&Limit=500&StartIndex=0`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(songs.status, 200)
    const songsPayload = await songs.json()
    assert.equal(songsPayload.TotalRecordCount, 1)
    assert.equal(songsPayload.Items[0].Name, 'QQ Favorite Song')
    assert.equal(songsPayload.Items[0].UserData.IsFavorite, true)

    const albums = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=MusicAlbum&ParentId=x-music-music&Filters=IsFavorite&Limit=500&StartIndex=0`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(albums.status, 200)
    const albumsPayload = await albums.json()
    assert.equal(albumsPayload.TotalRecordCount, 1)
    assert.equal(albumsPayload.Items[0].Name, 'Emby Favorite Album')
    assert.equal(decodeVirtualId(albumsPayload.Items[0].Id), undefined)
    assert.equal(qqFavoriteRequests, 1)

    const musiverFavoriteSongs = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&Recursive=true&Fields=AudioInfo%2CSortName%2CMediaSources%2CDateCreated%2CProductionYear%2CCanDelete&StartIndex=0&Limit=100&ImageTypeLimit=1&EnableImageTypes=Primary&SortBy=SortName&SortOrder=Descending&isFavorite=true&ParentId=x-music-music`, {
        headers: { authorization: authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(musiverFavoriteSongs.status, 200)
    const musiverFavoriteSongsPayload = await musiverFavoriteSongs.json()
    assert.equal(musiverFavoriteSongsPayload.TotalRecordCount, 1)
    assert.equal(musiverFavoriteSongsPayload.Items[0].Name, 'QQ Favorite Song')
    assert.equal(musiverFavoriteSongsPayload.Items[0].CanDelete, false)
    assert.equal(musiverFavoriteSongsPayload.Items[0].Container, 'mp3')
    assert.ok(musiverFavoriteSongsPayload.Items[0].SortName)
    assert.equal(musiverFavoriteSongsPayload.Items[0].MediaType, 'Audio')
    assert.equal(musiverFavoriteSongsPayload.Items[0].IsFolder, false)
    assert.equal(musiverFavoriteSongsPayload.Items[0].Size, 1024)
    assert.equal(musiverFavoriteSongsPayload.Items[0].Bitrate, 320000)
    assert.equal(musiverFavoriteSongsPayload.Items[0].ProductionYear, 2024)
    assert.equal(musiverFavoriteSongsPayload.Items[0].AlbumPrimaryImageTag, musiverFavoriteSongsPayload.Items[0].Id)
    assert.equal(musiverFavoriteSongsPayload.Items[0].ImageTags.Primary, musiverFavoriteSongsPayload.Items[0].Id)
    assert.equal(musiverFavoriteSongsPayload.Items[0].UserData.Played, false)
    assert.equal(musiverFavoriteSongsPayload.Items[0].MediaSources[0].Protocol, 'Http')
    assert.equal(musiverFavoriteSongsPayload.Items[0].MediaSources[0].Type, 'Default')
    assert.equal(musiverFavoriteSongsPayload.Items[0].MediaSources[0].Size, 1024)
    assert.equal(musiverFavoriteSongsPayload.Items[0].MediaSources[0].Bitrate, 320000)
    assert.equal(musiverFavoriteSongsPayload.Items[0].MediaSources[0].DefaultAudioStreamIndex, 0)
    assert.equal(musiverFavoriteSongsPayload.Items[0].MediaSources[0].MediaStreams[0].Type, 'Audio')
    assert.equal(musiverFavoriteSongsPayload.Items[0].MediaSources[0].MediaStreams[0].DisplayTitle, 'MP3 stereo')
    assert.equal(musiverFavoriteSongsPayload.Items[0].MediaSources[0].MediaStreams[0].AttachmentSize, 0)
    assert.equal(musiverFavoriteSongsPayload.Items[0].HasLyrics, true)
    assert.equal(musiverFavoriteSongsPayload.Items[0].MediaSources[0].MediaStreams[1].Type, 'Subtitle')
    assert.equal(musiverFavoriteSongsPayload.Items[0].MediaSources[0].MediaStreams[1].Codec, 'lrc')
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999011')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('virtual.song.qq-favorite-song-1')
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('virtual.album.qq-album-1')
    globalThis.fetch = originalFetch
  }
})

test('local emby favorite songs pages through QQ results beyond 200', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999012')
    saveQQLoginCookie('uin=o999012; euin=encrypted999012; qm_keyst=test-key')
    markAccountUpstreamBound('999012')
    const account = getAccountByQQ('999012')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`

    const favoriteRequests: URL[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        favoriteRequests.push(requestUrl)
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
        const begin = Number(body.req?.param?.song_begin ?? 0)
        const count = Number(body.req?.param?.song_num ?? 0)
        const total = 450
        const pageLength = Math.max(0, Math.min(count, total - begin))
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              songlist: Array.from({ length: pageLength }, (_, index) => {
                const id = begin + index + 1
                return {
                  id,
                  mid: `qq-favorite-page-${id}`,
                  title: `QQ Favorite ${id}`,
                  interval: 188,
                  singer: [{ name: 'QQ Artist', mid: 'qq-artist-1' }],
                  album: { name: 'QQ Favorite Album', mid: 'qq-album-1' },
                  file: { media_mid: `qq-media-${id}`, size_320mp3: 1024 },
                }
              }),
              total_song_num: total,
            },
          },
        })
      }

      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const songs = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=x-music-music&Filters=IsFavorite&Limit=500&StartIndex=0`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(songs.status, 200)
    const payload = await songs.json()
    assert.equal(payload.TotalRecordCount, 450)
    assert.equal(payload.Items.length, 450)
    assert.equal(payload.Items[449].Name, 'QQ Favorite 450')
    assert.equal(favoriteRequests.length, 5)

    const cachedSongs = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=x-music-music&Filters=IsFavorite&Limit=100&StartIndex=0`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(cachedSongs.status, 200)
    assert.equal((await cachedSongs.json()).TotalRecordCount, 450)
    assert.equal(favoriteRequests.length, 6)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999012')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key LIKE 'virtual.song.qq-favorite-page-%'").run()
    globalThis.fetch = originalFetch
  }
})

test('local emby favorite songs include QQ songs without media mid', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999023')
    saveQQLoginCookie('uin=o999023; euin=encrypted999023; qm_keyst=test-key')
    markAccountUpstreamBound('999023')
    const account = getAccountByQQ('999023')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`

    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              songlist: [{
                id: 2,
                mid: 'qq-favorite-no-media-mid',
                title: 'QQ Favorite Without Media Mid',
                interval: 188,
                singer: [{ name: 'QQ Artist', mid: 'qq-artist-1' }],
                album: { name: 'QQ Favorite Album', mid: 'qq-album-1' },
                file: {},
              }],
              total_song_num: 1,
            },
          },
        })
      }

      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const songs = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=x-music-music&Filters=IsFavorite&Limit=500&StartIndex=0`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(songs.status, 200)
    const payload = await songs.json()
    assert.equal(payload.TotalRecordCount, 1)
    assert.equal(payload.Items[0].Name, 'QQ Favorite Without Media Mid')
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999023')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key = 'virtual.song.qq-favorite-no-media-mid'").run()
    globalThis.fetch = originalFetch
  }
})

test('local emby favorite songs uses estimated total before QQ calibration', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999025')
    saveQQLoginCookie('uin=o999025; euin=encrypted999025; qm_keyst=test-key')
    markAccountUpstreamBound('999025')
    const account = getAccountByQQ('999025')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`

    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        return Response.json({ code: 500, req: { code: 500 } })
      }

      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const failed = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=x-music-music&Filters=IsFavorite&Limit=100&StartIndex=0`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(failed.status, 200)
    assert.equal((await failed.json()).TotalRecordCount, 999)

    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              songlist: [{
                id: 1,
                mid: 'qq-favorite-calibrated-1',
                title: 'QQ Favorite Calibrated',
                interval: 188,
                singer: [{ name: 'QQ Artist', mid: 'qq-artist-1' }],
                album: { name: 'QQ Favorite Album', mid: 'qq-album-1' },
                file: { media_mid: 'qq-media-calibrated-1', size_320mp3: 1024 },
              }],
              total_song_num: 1,
            },
          },
        })
      }

      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const calibrated = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=x-music-music&Filters=IsFavorite&Limit=100&StartIndex=0`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(calibrated.status, 200)
    assert.equal((await calibrated.json()).TotalRecordCount, 1)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999025')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key LIKE 'virtual.song.qq-favorite-calibrated-%'").run()
    globalThis.fetch = originalFetch
  }
})

test('local emby favorite songs keeps estimated total for partial deduped windows', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999026')
    saveQQLoginCookie('uin=o999026; euin=encrypted999026; qm_keyst=test-key')
    markAccountUpstreamBound('999026')
    const account = getAccountByQQ('999026')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
        const begin = Number(body.req?.param?.song_begin ?? 0)
        const count = Number(body.req?.param?.song_num ?? 0)
        const total = 383
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              songlist: Array.from({ length: Math.max(0, Math.min(count, total - begin)) }, (_, index) => {
                const duplicateGroup = Math.trunc((begin + index) / 2)
                return {
                  id: begin + index + 1,
                  mid: `qq-favorite-partial-${duplicateGroup}`,
                  title: `QQ Favorite Partial ${duplicateGroup}`,
                  interval: 188,
                  singer: [{ name: 'QQ Artist', mid: 'qq-artist-1' }],
                  album: { name: 'QQ Favorite Album', mid: 'qq-album-1' },
                  file: { media_mid: `qq-media-partial-${duplicateGroup}`, size_320mp3: 1024 },
                }
              }),
              total_song_num: total,
            },
          },
        })
      }

      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=x-music-music&Filters=IsFavorite&Limit=100&StartIndex=100`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.TotalRecordCount, 999)
    assert.ok(payload.Items.length < 100)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999026')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key LIKE 'virtual.song.qq-favorite-partial-%'").run()
    globalThis.fetch = originalFetch
  }
})

test('local emby favorite songs return all QQ pages when client omits pagination', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999021')
    saveQQLoginCookie('uin=o999021; euin=encrypted999021; qm_keyst=test-key')
    markAccountUpstreamBound('999021')
    const account = getAccountByQQ('999021')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`

    const favoriteBegins: number[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
        const begin = Number(body.req?.param?.song_begin ?? 0)
        const count = Number(body.req?.param?.song_num ?? 0)
        const total = 225
        favoriteBegins.push(begin)
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              songlist: Array.from({ length: Math.max(0, Math.min(count, total - begin)) }, (_, index) => {
                const id = begin + index + 1
                return {
                  id,
                  mid: `qq-favorite-all-${id}`,
                  title: `QQ Favorite All ${id}`,
                  interval: 188,
                  singer: [{ name: 'QQ Artist', mid: 'qq-artist-1' }],
                  album: { name: 'QQ Favorite Album', mid: 'qq-album-1' },
                  file: { media_mid: `qq-media-${id}`, size_320mp3: 1024 },
                }
              }),
              total_song_num: total,
            },
          },
        })
      }

      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=x-music-music&Filters=IsFavorite`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.TotalRecordCount, 225)
    assert.equal(payload.Items.length, 225)
    assert.equal(payload.Items[224].Name, 'QQ Favorite All 225')
    assert.deepEqual(favoriteBegins, [0, 100, 200])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999021')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key LIKE 'virtual.song.qq-favorite-all-%'").run()
    globalThis.fetch = originalFetch
  }
})

test('local emby favorite songs sort mixed sources by favorite time descending', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999022')
    saveQQLoginCookie('uin=o999022; euin=encrypted999022; qm_keyst=test-key')
    markAccountUpstreamBound('999022')
    const account = getAccountByQQ('999022')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
        const begin = Number(body.req?.param?.song_begin ?? 0)
        const count = Number(body.req?.param?.song_num ?? 0)
        const total = 2
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              songlist: Array.from({ length: Math.max(0, Math.min(count, total - begin)) }, (_, index) => {
                const id = begin + index + 1
                return {
                  id,
                  mid: `qq-favorite-order-${id}`,
                  title: `QQ Favorite Order ${id}`,
                  interval: 188,
                  singer: [{ name: 'QQ Artist', mid: 'qq-artist-1' }],
                  album: { name: 'QQ Favorite Album', mid: 'qq-album-1' },
                  fav_time: id === 1 ? '2024-01-04T00:00:00.000Z' : '2024-01-01T00:00:00.000Z',
                  file: { media_mid: `qq-media-${id}`, size_320mp3: 1024 },
                }
              }),
              total_song_num: total,
            },
          },
        })
      }

      return Response.json({
        Items: [
          { Id: 'emby-real-favorite-1', Name: 'Emby Real Favorite 1', Type: 'Audio', DateCreated: '2024-01-02T00:00:00.000Z' },
          { Id: 'emby-real-favorite-2', Name: 'Emby Real Favorite 2', Type: 'Audio', DateCreated: '2024-01-03T00:00:00.000Z' },
        ],
        TotalRecordCount: 2,
      })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=x-music-music&Filters=IsFavorite&Limit=3&StartIndex=0`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.TotalRecordCount, 4)
    assert.deepEqual(payload.Items.map((item: { Name: string }) => item.Name), [
      'QQ Favorite Order 1',
      'Emby Real Favorite 2',
      'Emby Real Favorite 1',
    ])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999022')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key LIKE 'virtual.song.qq-favorite-order-%'").run()
    globalThis.fetch = originalFetch
  }
})

test('local emby favorite songs count merged deduped items', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999024')
    saveQQLoginCookie('uin=o999024; euin=encrypted999024; qm_keyst=test-key')
    markAccountUpstreamBound('999024')
    const account = getAccountByQQ('999024')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
        assert.equal(Number(body.req?.param?.song_begin ?? 0), 0)
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              songlist: [
                {
                  id: 1,
                  mid: 'qq-favorite-overlap-1',
                  title: 'Overlapped Favorite',
                  interval: 188,
                  singer: [{ name: 'Shared Artist', mid: 'qq-artist-1' }],
                  album: { name: 'QQ Favorite Album', mid: 'qq-album-1' },
                  file: { media_mid: 'qq-media-overlap-1', size_320mp3: 1024 },
                },
                {
                  id: 2,
                  mid: 'qq-favorite-unique-2',
                  title: 'QQ Unique Favorite',
                  interval: 188,
                  singer: [{ name: 'QQ Artist', mid: 'qq-artist-2' }],
                  album: { name: 'QQ Favorite Album', mid: 'qq-album-1' },
                  file: { media_mid: 'qq-media-unique-2', size_320mp3: 1024 },
                },
              ],
              total_song_num: 2,
            },
          },
        })
      }

      return Response.json({
        Items: [
          { Id: 'emby-overlap-1', Name: 'Overlapped Favorite', Type: 'Audio', Artists: ['Shared Artist'] },
          { Id: 'emby-real-favorite-2', Name: 'Emby Unique Favorite', Type: 'Audio', Artists: ['Emby Artist'] },
        ],
        TotalRecordCount: 2,
      })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=x-music-music&Filters=IsFavorite&Limit=10&StartIndex=0`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.TotalRecordCount, 3)
    assert.deepEqual(payload.Items.map((item: { Name: string }) => item.Name).sort(), [
      'Emby Unique Favorite',
      'Overlapped Favorite',
      'QQ Unique Favorite',
    ])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999024')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key LIKE 'virtual.song.qq-favorite-overlap-%'").run()
    db.prepare("DELETE FROM app_settings WHERE key LIKE 'virtual.song.qq-favorite-unique-%'").run()
    globalThis.fetch = originalFetch
  }
})

test('local emby genres include QQ favorite album bucket when upstream has no genres', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999015')
    saveQQLoginCookie('uin=o999015; euin=encrypted999015; qm_keyst=test-key')
    markAccountUpstreamBound('999015')
    const account = getAccountByQQ('999015')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`

    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              songlist: [{
                id: 123,
                mid: 'qq-genre-song-1',
                title: 'QQ Genre Song',
                interval: 188,
                singer: [{ name: 'QQ Artist', mid: 'qq-artist-1' }],
                album: { name: 'QQ Favorite Album', mid: 'qq-album-1' },
                file: { media_mid: 'qq-media-1', size_320mp3: 1024 },
              }],
              total_song_num: 1,
            },
          },
        })
      }

      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const genres = await dispatchEmbyRequest(
      new Request(`http://local/emby/Genres?UserId=${authPayload.User.Id}&ParentId=x-music-music&IncludeItemTypes=MusicAlbum&Limit=500&StartIndex=0`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix('/emby/Genres'),
    )
    assert.equal(genres.status, 200)
    const payload = await genres.json()
    assert.equal(payload.TotalRecordCount, 1)
    assert.equal(payload.Items[0].Name, 'QQ Music')
    assert.equal(payload.Items[0].Type, 'Genre')
    assert.equal(decodeVirtualId(payload.Items[0].Id)?.kind, 'qq-genre')
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999015')
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('local emby query parent id expands QQ virtual playlist items', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999008')
    saveQQLoginCookie('uin=o999008; qm_keyst=test-key')
    markAccountUpstreamBound('999008')
    const account = getAccountByQQ('999008')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const dailyId = encodeVirtualId({ kind: 'qq-daily' })
    const upstreamRequests: string[] = []

    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'c.y.qq.com' && requestUrl.pathname.includes('client_music_search_songlist')) {
        return Response.json({
          code: 0,
          data: {
            sum: 1,
            list: [{
              dissid: '123456789',
              dissname: 'QQ音乐 Daily 30',
              creator: { name: 'QQ Music' },
              song_count: 1,
            }],
          },
        })
      }

      if (requestUrl.hostname === 'c.y.qq.com' && requestUrl.pathname.includes('fcg_ucc_getcdinfo_byids_cp')) {
        return Response.json({
          code: 0,
          cdlist: [{
            disstid: '123456789',
            dissname: 'QQ音乐 Daily 30',
            songlist: [{
              id: 123,
              mid: 'qq-daily-song-1',
              title: 'QQ Daily Song',
              interval: 188,
              singer: [{ name: 'QQ Artist', mid: 'qq-artist-1' }],
              album: { name: 'QQ Album', mid: 'qq-album-1' },
              file: { media_mid: 'qq-media-1', size_320mp3: 1024 },
            }],
          }],
        })
      }

      upstreamRequests.push(String(url))
      return Response.json({ error: 'virtual parent leaked upstream' }, { status: 500 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio%2CMusicVideo&Fields=AudioInfo&EnableUserData=true&Recursive=true&ParentId=${encodeURIComponent(dailyId)}&SortBy=ListItemOrder&SortOrder=Ascending&Limit=1000&StartIndex=0`, {
        headers: {
          'X-Emby-Authorization': `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`,
        },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.TotalRecordCount, 1)
    assert.equal(payload.Items[0].Name, 'QQ Daily Song')
    assert.equal(decodeVirtualId(payload.Items[0].Id)?.kind, 'qq-song')
    assert.deepEqual(upstreamRequests, [])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999008')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('virtual.song.qq-daily-song-1')
    globalThis.fetch = originalFetch
  }
})

test('local emby recommendation playlists cap QQ recommendation limit', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999018')
    saveQQLoginCookie('uin=o999018; qm_keyst=test-key')
    markAccountUpstreamBound('999018')
    const account = getAccountByQQ('999018')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const guessId = encodeVirtualId({ kind: 'qq-guess' })

    const recommendationLimits: number[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
        if (body.req?.module === 'music.radioProxy.MbTrackRadioSvr') {
          const pageSize = Number(body.req.param.num ?? 0)
          recommendationLimits.push(pageSize)
          return Response.json({
            code: 0,
            req: {
              code: 0,
              data: {
                Tracks: Array.from({ length: pageSize }, (_, index) => {
                  const id = recommendationLimits.length * 1000 + index
                  return {
                    id,
                    mid: `qq-rec-song-${id}`,
                    title: `QQ Rec ${id}`,
                    interval: 188,
                    singer: [{ name: 'QQ Artist', mid: 'qq-artist-1' }],
                    album: { name: 'QQ Album', mid: 'qq-album-1' },
                    file: { media_mid: `qq-media-${id}`, size_320mp3: 1024 },
                  }
                }),
              },
            },
          })
        }
      }

      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio%2CMusicVideo&ParentId=${encodeURIComponent(guessId)}&Limit=250&StartIndex=0`, {
        headers: {
          'X-Emby-Authorization': `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`,
        },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.Items.length, 250)
    assert.deepEqual(recommendationLimits, [100, 100, 50])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999018')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key LIKE 'virtual.song.qq-rec-song-%'").run()
    globalThis.fetch = originalFetch
  }
})

test('local emby virtual playlist item details stay local', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999027')
    saveQQLoginCookie('uin=o999027; qm_keyst=test-key')
    markAccountUpstreamBound('999027')
    const account = getAccountByQQ('999027')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const guessId = encodeVirtualId({ kind: 'qq-guess' })
    const dailyId = encodeVirtualId({ kind: 'qq-daily' })
    const upstreamRequests: string[] = []

    globalThis.fetch = (async (url: string | URL | Request) => {
      upstreamRequests.push(String(url))
      return Response.json({ error: 'virtual playlist id leaked upstream' }, { status: 500 })
    }) as typeof fetch

    for (const [id, name] of [[guessId, 'QQ 猜你喜欢'], [dailyId, 'QQ 每日推荐']] as const) {
      const response = await dispatchEmbyRequest(
        new Request(`http://local/emby/Users/${authPayload.User.Id}/Items/${encodeURIComponent(id)}`, {
          headers: { 'X-Emby-Authorization': `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"` },
        }),
        stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items/${encodeURIComponent(id)}`),
      )
      assert.equal(response.status, 200)
      const payload = await response.json()
      assert.equal(payload.Name, name)
      assert.equal(payload.IsFolder, true)
      assert.equal(payload.Type, 'Playlist')
    }
    assert.deepEqual(upstreamRequests, [])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999027')
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('local emby virtual genre video filters stay local and empty', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999028')
    saveQQLoginCookie('uin=o999028; qm_keyst=test-key')
    markAccountUpstreamBound('999028')
    const account = getAccountByQQ('999028')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const genreId = encodeVirtualId({ kind: 'qq-genre', id: 'QQ Music' })
    const upstreamRequests: string[] = []

    globalThis.fetch = (async (url: string | URL | Request) => {
      upstreamRequests.push(String(url))
      return Response.json({ error: 'virtual genre id leaked upstream' }, { status: 500 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?Fields=BasicSyncInfo%2CCanDelete%2CContainer%2CPrimaryImageAspectRatio%2CProductionYear%2CStatus%2CEndDate%2CPrefix&EnableImageTypes=Primary%2CBackdrop%2CThumb&ImageTypeLimit=1&StartIndex=0&Limit=50&ParentId=11696830&SortBy=SortName&SortOrder=Ascending&IncludeItemTypes=Movie%2CSeries%2CVideo&Recursive=true&GenreIds=${encodeURIComponent(genreId)}`, {
        headers: { 'X-Emby-Authorization': `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"` },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { Items: [], TotalRecordCount: 0 })
    assert.deepEqual(upstreamRequests, [])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999028')
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('local emby played lists merge local QQ play history', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999013')
    saveQQLoginCookie('uin=o999013; qm_keyst=test-key')
    markAccountUpstreamBound('999013')
    const account = getAccountByQQ('999013')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`

    const song = {
      source: 'tx' as const,
      songmid: 'qq-played-song-1',
      name: 'QQ Played Song',
      singer: 'QQ Artist',
      albumName: 'QQ Album',
      albumId: 'qq-album',
      interval: '03:08',
      img: 'https://example.com/cover.jpg',
    }
    db.prepare(`
      INSERT INTO tracks (source, songmid, name, singer, album_name, album_id, interval, image_url, raw_json, updated_at)
      VALUES ('tx', @songmid, @name, @singer, @albumName, @albumId, @interval, @img, @raw, CURRENT_TIMESTAMP)
      ON CONFLICT(source, songmid) DO UPDATE SET name = excluded.name, updated_at = CURRENT_TIMESTAMP
    `).run({ ...song, raw: JSON.stringify(song) })
    const track = db.prepare("SELECT id FROM tracks WHERE source = 'tx' AND songmid = ?").get(song.songmid) as { id: number }
    db.prepare('INSERT INTO play_events (track_id, quality, played_at) VALUES (?, ?, ?)').run(track.id, '320k', '2026-05-21T10:00:00.000Z')
    db.prepare('INSERT INTO play_events (track_id, quality, played_at) VALUES (?, ?, ?)').run(track.id, '320k', '2026-05-22T10:00:00.000Z')

    globalThis.fetch = (async () => Response.json({ Items: [], TotalRecordCount: 0 })) as typeof fetch

    const mostPlayed = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=x-music-music&Filters=IsPlayed&SortBy=PlayCount%2CDatePlayed&SortOrder=Descending&Limit=500&StartIndex=0`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(mostPlayed.status, 200)
    const mostPlayedPayload = await mostPlayed.json()
    assert.ok(mostPlayedPayload.TotalRecordCount >= 1)
    const mostPlayedSong = mostPlayedPayload.Items.find((item: { Name: string }) => item.Name === 'QQ Played Song')
    assert.ok(mostPlayedSong)
    assert.equal(mostPlayedSong.UserData.PlayCount, 2)
    assert.equal(mostPlayedSong.UserData.LastPlayedDate, '2026-05-22T10:00:00.000Z')

    const recentlyPlayed = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=x-music-music&SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed&Limit=200&StartIndex=0`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(recentlyPlayed.status, 200)
    const recentlyPlayedPayload = await recentlyPlayed.json()
    assert.ok(recentlyPlayedPayload.TotalRecordCount >= 1)
    assert.ok(recentlyPlayedPayload.Items.some((item: { Name: string }) => item.Name === 'QQ Played Song'))
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999013')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key = 'virtual.song.qq-played-song-1'").run()
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run('qq-played-song-1')
    globalThis.fetch = originalFetch
  }
})

test('local emby virtual song item details and audio HEAD stay local', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999009')
    saveQQLoginCookie('uin=o999009; qm_keyst=test-key')
    markAccountUpstreamBound('999009')
    const account = getAccountByQQ('999009')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const playlistId = encodeVirtualId({ kind: 'qq-guess' })
    const songId = encodeVirtualId({ kind: 'qq-song', songmid: 'qq-play-song-1', playlistId })
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`

    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run('virtual.song.qq-play-song-1', JSON.stringify({
      playlistId,
      song: {
        source: 'tx',
        songmid: 'qq-play-song-1',
        name: 'QQ Play Song',
        singer: 'QQ Artist',
        albumName: 'QQ Album',
        albumId: 'qq-album',
        img: 'https://img.example/qq-play-song.jpg',
        interval: '03:08',
        types: [{ type: '320k', size: '1 MB' }],
        raw: { strMediaMid: 'qq-media-1' },
      },
    }))

    const upstreamRequests: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      upstreamRequests.push(String(url))
      return Response.json({ error: 'virtual id leaked upstream' }, { status: 500 })
    }) as typeof fetch

    const details = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items/${encodeURIComponent(songId)}`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items/${encodeURIComponent(songId)}`),
    )
    assert.equal(details.status, 200)
    const detailsPayload = await details.json()
    assert.equal(detailsPayload.Name, 'QQ Play Song')
    assert.equal(detailsPayload.Id, encodeVirtualId({ kind: 'qq-song', songmid: 'qq-play-song-1' }))

    const head = await dispatchEmbyRequest(
      new Request(`http://local/emby/Audio/${encodeURIComponent(songId)}/universal?api_key=${authPayload.AccessToken}`, {
        method: 'HEAD',
      }),
      stripOptionalEmbyPrefix(`/emby/Audio/${encodeURIComponent(songId)}/universal`),
    )
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-type'), 'audio/mpeg')
    assert.equal(head.headers.get('x-x-music-source'), 'upstream')
    assert.deepEqual(upstreamRequests, [])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999009')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('virtual.song.qq-play-song-1')
    globalThis.fetch = originalFetch
  }
})

test('local emby virtual song similar items stay local', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999023')
    saveQQLoginCookie('uin=o999023; qm_keyst=test-key')
    markAccountUpstreamBound('999023')
    const account = getAccountByQQ('999023')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const songId = encodeVirtualId({ kind: 'qq-song', songmid: 'qq-similar-song-1' })
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`

    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run('virtual.song.qq-similar-song-1', JSON.stringify({
      song: {
        source: 'tx',
        songmid: 'qq-similar-song-1',
        name: 'QQ Similar Seed',
        singer: 'QQ Similar Artist',
        albumName: 'QQ Album',
        interval: '03:08',
        types: [{ type: '320k', size: '1 MB' }],
        raw: { strMediaMid: 'qq-media-seed' },
      },
    }))

    const upstreamRequests: string[] = []
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run('virtual.song.qq-artist-seed', JSON.stringify({
      song: {
        source: 'tx',
        songmid: 'qq-artist-seed',
        name: 'QQ Artist Seed',
        singer: 'QQ Artist From Cache',
        interval: '03:08',
        types: [{ type: '320k', size: '1 MB' }],
        raw: { strMediaMid: 'qq-media-seed' },
      },
    }))
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
        const pageSize = Number(body.req?.param?.num_per_page ?? 0)
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              body: {
                item_song: Array.from({ length: pageSize }, (_, index) => ({
                  id: index + 1,
                  mid: `qq-similar-result-${index + 1}`,
                  title: `QQ Similar Result ${index + 1}`,
                  interval: 188,
                  singer: [{ name: 'QQ Similar Artist', mid: 'qq-artist-1' }],
                  album: { name: 'QQ Album', mid: 'qq-album-1' },
                  file: { media_mid: `qq-media-${index + 1}`, size_320mp3: 1024 },
                })),
              },
              meta: { estimate_sum: pageSize },
            },
          },
        })
      }
      upstreamRequests.push(String(url))
      return Response.json({ error: 'virtual id leaked upstream' }, { status: 500 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/Items/${encodeURIComponent(songId)}/Similar?Limit=3&Fields=AudioInfo`, {
        headers: { authorization: authHeader },
      }),
      stripOptionalEmbyPrefix(`/Items/${encodeURIComponent(songId)}/Similar`),
    )
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.Items.length, 3)
    assert.equal(payload.Items[0].Type, 'Audio')
    assert.deepEqual(upstreamRequests, [])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999023')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key LIKE 'virtual.song.qq-similar-%'").run()
    globalThis.fetch = originalFetch
  }
})

test('local emby virtual song lyrics return timed lyric lines', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999024')
    saveQQLoginCookie('uin=o999024; qm_keyst=test-key')
    markAccountUpstreamBound('999024')
    const account = getAccountByQQ('999024')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const songId = encodeVirtualId({ kind: 'qq-song', songmid: 'qq-lyrics-song-1' })
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`

    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run('virtual.song.qq-lyrics-song-1', JSON.stringify({
      song: {
        source: 'tx',
        songmid: 'qq-lyrics-song-1',
        name: 'QQ Lyrics Song',
        singer: 'QQ Lyrics Artist',
        albumName: 'QQ Lyrics Album',
        interval: '03:08',
        types: [{ type: '320k', size: '1 MB' }],
        raw: { strMediaMid: 'qq-media-lyrics' },
      },
    }))

    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.pathname.includes('/lyric/fcgi-bin/fcg_query_lyric_new.fcg')) {
        return Response.json({
          lyric: Buffer.from('[00:01.23]第一句\n[00:04.00]第二句', 'utf8').toString('base64'),
        })
      }
      return Response.json({ error: 'unexpected upstream request' }, { status: 500 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/Items/${encodeURIComponent(songId)}/Lyrics`, {
        headers: { authorization: authHeader },
      }),
      stripOptionalEmbyPrefix(`/Items/${encodeURIComponent(songId)}/Lyrics`),
    )
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.deepEqual(payload.Lyrics, [
      { Start: 12300000, Text: '第一句' },
      { Start: 40000000, Text: '第二句' },
    ])
    assert.deepEqual(payload.Lines, payload.Lyrics)
    assert.match(payload.Text, /第一句/)

    const raw = await dispatchEmbyRequest(
      new Request(`http://local/Items/${encodeURIComponent(songId)}/Lyrics?format=lrc`, {
        headers: { authorization: authHeader },
      }),
      stripOptionalEmbyPrefix(`/Items/${encodeURIComponent(songId)}/Lyrics`),
    )
    assert.equal(raw.status, 200)
    assert.match(await raw.text(), /第二句/)

    const playbackInfo = await dispatchEmbyRequest(
      new Request(`http://local/Items/${encodeURIComponent(songId)}/PlaybackInfo`, {
        headers: { authorization: authHeader },
      }),
      stripOptionalEmbyPrefix(`/Items/${encodeURIComponent(songId)}/PlaybackInfo`),
    )
    assert.equal(playbackInfo.status, 200)
    const playbackPayload = await playbackInfo.json()
    assert.equal(playbackPayload.MediaSources[0].MediaStreams[1].Type, 'Subtitle')
    assert.equal(playbackPayload.MediaSources[0].MediaStreams[1].Index, 2)
    assert.equal(playbackPayload.MediaSources[0].MediaStreams[1].DeliveryMethod, 'External')
    assert.match(playbackPayload.MediaSources[0].MediaStreams[1].DeliveryUrl, /Stream\.lrc$/)
    assert.match(playbackPayload.MediaSources[0].MediaStreams[1].DeliveryUrl, /\/Subtitles\/2\/Stream\.lrc$/)

    const subtitle = await dispatchEmbyRequest(
      new Request(`http://local/Items/${encodeURIComponent(songId)}/${encodeURIComponent(songId)}/Subtitles/1/Stream.lrc`, {
        headers: { authorization: authHeader },
      }),
      stripOptionalEmbyPrefix(`/Items/${encodeURIComponent(songId)}/${encodeURIComponent(songId)}/Subtitles/1/Stream.lrc`),
    )
    assert.equal(subtitle.status, 200)
    assert.match(subtitle.headers.get('content-type') ?? '', /text\/plain/)
    assert.match(await subtitle.text(), /第一句/)

    const amcfySubtitle = await dispatchEmbyRequest(
      new Request(`http://local/Items/${encodeURIComponent(songId)}/Subtitles/2/Stream.js?id=${encodeURIComponent(songId)}&content-type=application%2Fjson&X-Emby-Client=Amcfy%20Music%20for%20iOS&X-Emby-Token=${authPayload.AccessToken}`, {
        headers: { 'user-agent': 'Amcfy Music/1.0.20' },
      }),
      stripOptionalEmbyPrefix(`/Items/${encodeURIComponent(songId)}/Subtitles/2/Stream.js`),
    )
    assert.equal(amcfySubtitle.status, 200)
    assert.match(amcfySubtitle.headers.get('content-type') ?? '', /application\/json/)
    const amcfyPayload = await amcfySubtitle.json()
    assert.equal(amcfyPayload.TrackEvents[0].Text, '第一句')

    const queryTokenSubtitle = await dispatchEmbyRequest(
      new Request(`http://local/Items/${encodeURIComponent(songId)}/${encodeURIComponent(songId)}/Subtitles/1/Stream.js?MediaBrowser%20Client=Musiver&Device=Mi-Mini-M2&Version=1.3.9&Token=${authPayload.AccessToken}`, {
        headers: { 'user-agent': 'musiver/1.3.9 (Macintosh)' },
      }),
      stripOptionalEmbyPrefix(`/Items/${encodeURIComponent(songId)}/${encodeURIComponent(songId)}/Subtitles/1/Stream.js`),
    )
    assert.equal(queryTokenSubtitle.status, 200)
    assert.match(queryTokenSubtitle.headers.get('content-type') ?? '', /application\/json/)
    const subtitlePayload = await queryTokenSubtitle.json()
    assert.deepEqual(subtitlePayload.TrackEvents, [
      { Id: '1', Text: '第一句', StartPositionTicks: 12300000, EndPositionTicks: 40000000 },
      { Id: '2', Text: '第二句', StartPositionTicks: 40000000, EndPositionTicks: 70000000 },
    ])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999024')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key = 'virtual.song.qq-lyrics-song-1'").run()
    globalThis.fetch = originalFetch
  }
})

test('local emby virtual artist filters stay local instead of leaking invalid ids upstream', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999025')
    saveQQLoginCookie('uin=o999025; euin=encrypted999025; qm_keyst=test-key')
    markAccountUpstreamBound('999025')
    const account = getAccountByQQ('999025')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`

    const upstreamRequests: string[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
        const begin = Number(body.req?.param?.song_begin ?? 0)
        const count = Number(body.req?.param?.song_num ?? 0)
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              songlist: Array.from({ length: Math.max(0, Math.min(count, 2 - begin)) }, (_, index) => {
                const id = begin + index + 1
                return {
                  id,
                  mid: `qq-artist-filter-${id}`,
                  title: `QQ Artist Filter ${id}`,
                  interval: 188,
                  singer: [{ name: id === 1 ? 'QQ Artist From Cache' : 'Other Artist', mid: 'qq-artist-1' }],
                  album: { name: 'QQ Album', mid: 'qq-album-1' },
                  file: { media_mid: `qq-media-${id}`, size_320mp3: 1024 },
                }
              }),
              total_song_num: 2,
            },
          },
        })
      }
      upstreamRequests.push(String(url))
      return Response.json({ error: 'Guid should contain 32 digits with 4 dashes' }, { status: 500 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&Recursive=true&Limit=30&ArtistIds=qq-artist-seed-artist-0`, {
        headers: { authorization: authHeader },
      }),
      stripOptionalEmbyPrefix(`/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.TotalRecordCount, 1)
    assert.equal(payload.Items[0].Name, 'QQ Artist Seed')
    assert.equal(payload.Items[0].HasLyrics, true)
    assert.equal(payload.Items[0].MediaSources[0].MediaStreams[1].Codec, 'lrc')
    assert.deepEqual(upstreamRequests, [])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999025')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key LIKE 'virtual.song.qq-artist-filter-%'").run()
    db.prepare("DELETE FROM app_settings WHERE key = 'virtual.song.qq-artist-seed'").run()
    globalThis.fetch = originalFetch
  }
})

test('musiver virtual song detail and artist filter keep lyrics and cover metadata', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999031')
    saveQQLoginCookie('uin=o999031; qm_keyst=test-key')
    markAccountUpstreamBound('999031')
    const account = getAccountByQQ('999031')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const songId = encodeVirtualId({ kind: 'qq-song', songmid: '0017Zt260lV7ll' })
    const authHeader = `MediaBrowser Client="Musiver", Device="Mi-Mini-M2", Version="1.3.9", Token="${authPayload.AccessToken}"`

    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run('virtual.song.0017Zt260lV7ll', JSON.stringify({
      song: {
        source: 'tx',
        songmid: '0017Zt260lV7ll',
        name: 'Musiver Virtual Song',
        singer: 'Musiver Artist',
        albumName: 'Musiver Album',
        albumId: '003virtualAlbum',
        interval: '03:08',
        img: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000003virtualAlbum.jpg',
        types: [{ type: '320k', size: '1 MB' }],
        raw: { strMediaMid: 'qq-media-musiver' },
      },
    }))

    const upstreamRequests: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      upstreamRequests.push(String(url))
      return Response.json({ error: 'virtual request leaked upstream' }, { status: 500 })
    }) as typeof fetch

    const detail = await dispatchEmbyRequest(
      new Request(`http://local/Users/${authPayload.User.Id}/Items/${encodeURIComponent(songId)}`, {
        headers: { authorization: authHeader, 'user-agent': 'musiver/1.3.9 (Macintosh)' },
      }),
      stripOptionalEmbyPrefix(`/Users/${authPayload.User.Id}/Items/${encodeURIComponent(songId)}`),
    )
    assert.equal(detail.status, 200)
    const detailPayload = await detail.json()
    assert.equal(detailPayload.Name, 'Musiver Virtual Song')
    assert.equal(detailPayload.ImageTags.Primary, songId)
    assert.equal(detailPayload.AlbumPrimaryImageTag, songId)
    assert.equal(detailPayload.HasLyrics, true)
    assert.equal(detailPayload.MediaSources[0].MediaStreams[1].Codec, 'lrc')

    const artistItems = await dispatchEmbyRequest(
      new Request(`http://local/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&Recursive=true&Fields=AudioInfo%2CSortName%2CMediaSources%2CDateCreated%2CProductionYear%2CCanDelete&StartIndex=0&Limit=30&ImageTypeLimit=1&EnableImageTypes=Primary&SortBy=CommunityRating&SortOrder=Descending&ArtistIds=0017Zt260lV7ll-artist-0`, {
        headers: { authorization: authHeader, 'user-agent': 'musiver/1.3.9 (Macintosh)' },
      }),
      stripOptionalEmbyPrefix(`/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(artistItems.status, 200)
    const artistPayload = await artistItems.json()
    assert.equal(artistPayload.TotalRecordCount, 1)
    assert.equal(artistPayload.Items[0].Name, 'Musiver Virtual Song')
    assert.equal(artistPayload.Items[0].ImageTags.Primary, songId)
    assert.equal(artistPayload.Items[0].HasLyrics, true)
    assert.equal(artistPayload.Items[0].MediaSources[0].MediaStreams[1].DeliveryMethod, 'External')
    assert.deepEqual(upstreamRequests, [])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999031')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key = 'virtual.song.0017Zt260lV7ll'").run()
    globalThis.fetch = originalFetch
  }
})

test('musiver virtual song detail fetches QQ metadata when cache is missing', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999037')
    saveQQLoginCookie('uin=o999037; qm_keyst=test-key')
    markAccountUpstreamBound('999037')
    const account = getAccountByQQ('999037')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const songId = encodeVirtualId({ kind: 'qq-song', songmid: 'qq-missing-cache-song' })
    const authHeader = `MediaBrowser Client="Musiver", Device="Mi-Mini-M2", Version="1.3.9", Token="${authPayload.AccessToken}"`

    const upstreamRequests: string[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { songinfo?: { param?: { song_mid?: string } } } : {}
        assert.equal(body.songinfo?.param?.song_mid, 'qq-missing-cache-song')
        return Response.json({
          code: 0,
          songinfo: {
            code: 0,
            data: {
              track_info: {
                id: 123,
                mid: 'qq-missing-cache-song',
                title: 'QQ Missing Cache Song',
                interval: 201,
                singer: [{ name: 'QQ Detail Artist', mid: 'qq-detail-artist' }],
                album: { name: 'QQ Detail Album', mid: 'qq-detail-album', time_public: '2026-01-01' },
                file: { media_mid: 'qq-detail-media', size_128mp3: 1024, size_320mp3: 2048 },
              },
            },
          },
        })
      }
      upstreamRequests.push(String(url))
      return Response.json({ error: 'virtual request leaked upstream' }, { status: 500 })
    }) as typeof fetch

    const detail = await dispatchEmbyRequest(
      new Request(`http://local/Users/${authPayload.User.Id}/Items/${encodeURIComponent(songId)}`, {
        headers: { authorization: authHeader, 'user-agent': 'musiver/1.3.9 (Macintosh)' },
      }),
      stripOptionalEmbyPrefix(`/Users/${authPayload.User.Id}/Items/${encodeURIComponent(songId)}`),
    )
    assert.equal(detail.status, 200)
    const payload = await detail.json()
    assert.equal(payload.Name, 'QQ Missing Cache Song')
    assert.equal(payload.ImageTags.Primary, songId)
    assert.equal(payload.AlbumPrimaryImageTag, songId)
    assert.equal(payload.HasLyrics, true)
    assert.equal(payload.MediaSources[0].MediaStreams[1].Codec, 'lrc')
    assert.deepEqual(upstreamRequests, [])
    const cached = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get('virtual.song.qq-missing-cache-song') as { value_json: string } | undefined
    assert.ok(cached)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999037')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key = 'virtual.song.qq-missing-cache-song'").run()
    globalThis.fetch = originalFetch
  }
})

test('local emby virtual audio GET records playback and syncs QQ history', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999014')
    saveQQLoginCookie('uin=o999014; qm_keyst=test-key')
    markAccountUpstreamBound('999014')
    const account = getAccountByQQ('999014')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const songId = encodeVirtualId({ kind: 'qq-song', songmid: 'qq-stream-song-1' })
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`

    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run('virtual.song.qq-stream-song-1', JSON.stringify({
      song: {
        source: 'tx',
        songmid: 'qq-stream-song-1',
        name: 'QQ Stream Song',
        singer: 'QQ Artist',
        albumName: 'QQ Album',
        albumId: 'qq-album',
        interval: '03:08',
        types: [{ type: '320k', size: '1 MB' }],
        raw: { songId: 123, songType: 0, strMediaMid: 'qq-media-1' },
      },
    }))
    const localAudioPath = join(process.cwd(), 'data/test-qq-stream-song.mp3')
    mkdirSync(join(process.cwd(), 'data'), { recursive: true })
    writeFileSync(localAudioPath, 'audio-bytes')
    db.prepare(`
      INSERT INTO tracks (source, songmid, name, singer, album_name, album_id, interval, image_url, raw_json, updated_at)
      VALUES ('tx', 'qq-stream-song-1', 'QQ Stream Song', 'QQ Artist', 'QQ Album', 'qq-album', '03:08', NULL, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(source, songmid) DO UPDATE SET name = excluded.name, updated_at = CURRENT_TIMESTAMP
    `).run(JSON.stringify({
      source: 'tx',
      songmid: 'qq-stream-song-1',
      name: 'QQ Stream Song',
      singer: 'QQ Artist',
      albumName: 'QQ Album',
      albumId: 'qq-album',
      interval: '03:08',
      raw: { songId: 123, songType: 0, strMediaMid: 'qq-media-1' },
    }))
    const track = db.prepare("SELECT id FROM tracks WHERE source = 'tx' AND songmid = 'qq-stream-song-1'").get() as { id: number }
    db.prepare(`
      INSERT INTO track_files (track_id, quality, status, raw_path, final_path, updated_at)
      VALUES (?, '320k', 'ready', ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(track_id, quality) DO UPDATE SET status = excluded.status, raw_path = excluded.raw_path, final_path = excluded.final_path, updated_at = CURRENT_TIMESTAMP
    `).run(track.id, localAudioPath, localAudioPath)

    const requestUrls: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      requestUrls.push(String(url))
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'script.example') return new Response('https://cdn.example/audio.mp3')
      if (requestUrl.hostname === 'stat6.y.qq.com') return new Response('{}')
      return new Response('https://cdn.example/audio.mp3')
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Audio/${encodeURIComponent(songId)}/universal?api_key=${authPayload.AccessToken}`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Audio/${encodeURIComponent(songId)}/universal`),
    )
    assert.equal(response.status, 200)
    const reader = response.body?.getReader()
    assert.ok(reader)
    const firstChunk = await reader.read()
    assert.equal(new TextDecoder().decode(firstChunk.value), 'audio-bytes')
    await reader.cancel()

    await waitFor(() => requestUrls.some(url => new URL(url).hostname === 'stat6.y.qq.com'))

    const playEvents = db.prepare(`
      SELECT COUNT(*) AS count
      FROM play_events pe
      INNER JOIN tracks t ON t.id = pe.track_id
      WHERE t.source = 'tx' AND t.songmid = 'qq-stream-song-1'
    `).get() as { count: number }
    assert.equal(playEvents.count, 1)
    assert.ok(requestUrls.some(url => new URL(url).hostname === 'stat6.y.qq.com'))
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999014')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('virtual.song.qq-stream-song-1')
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run('qq-stream-song-1')
    db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track' AND json_extract(payload_json, '$.songmid') = ?").run('qq-stream-song-1')
    rmSync(join(process.cwd(), 'data/test-qq-stream-song.mp3'), { force: true })
    globalThis.fetch = originalFetch
  }
})

test('local emby virtual audio GET returns playable errors as 502 JSON', async () => {
  const originalFetch = globalThis.fetch
  const originalLxMusicSourceScript = process.env.LX_MUSIC_SOURCE_SCRIPT
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999025')
    process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/legacy-lx?key=test-key'
    saveQQLoginCookie('uin=o999025; qm_keyst=test-key')
    markAccountUpstreamBound('999025')
    const account = getAccountByQQ('999025')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const songId = encodeVirtualId({ kind: 'qq-song', songmid: 'qq-audio-error-song-1' })
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`

    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run('virtual.song.qq-audio-error-song-1', JSON.stringify({
      song: {
        source: 'tx',
        songmid: 'qq-audio-error-song-1',
        name: 'QQ Audio Error Song',
        singer: 'QQ Artist',
        albumName: 'QQ Album',
        albumId: 'qq-album',
        interval: '03:08',
        types: [{ type: '320k', size: '1 MB' }],
        raw: { songId: 123, songType: 0, strMediaMid: 'qq-media-1' },
      },
    }))

    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'script.example') return new Response('https://cdn.example/audio.mp3')
      if (requestUrl.hostname === 'cdn.example') return new Response('missing', { status: 404 })
      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Audio/${encodeURIComponent(songId)}/universal?api_key=${authPayload.AccessToken}`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Audio/${encodeURIComponent(songId)}/universal`),
    )
    assert.equal(response.status, 502)
    const payload = await response.json()
    assert.match(payload.error, /upstream returned 404/)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999025')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('virtual.song.qq-audio-error-song-1')
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run('qq-audio-error-song-1')
    db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track' AND json_extract(payload_json, '$.songmid') = ?").run('qq-audio-error-song-1')
    globalThis.fetch = originalFetch
    if (originalLxMusicSourceScript === undefined) {
      delete process.env.LX_MUSIC_SOURCE_SCRIPT
    } else {
      process.env.LX_MUSIC_SOURCE_SCRIPT = originalLxMusicSourceScript
    }
  }
})

test('musiver virtual audio stream prefers mp3 quality requested by client', async () => {
  const originalFetch = globalThis.fetch
  const originalLxMusicSourceScript = process.env.LX_MUSIC_SOURCE_SCRIPT
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999032')
    process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/legacy-lx?key=test-key'
    saveQQLoginCookie('uin=o999032; qm_keyst=test-key')
    markAccountUpstreamBound('999032')
    const account = getAccountByQQ('999032')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const songId = encodeVirtualId({ kind: 'qq-song', songmid: '003CnoIy3AcyPE' })
    const authHeader = `MediaBrowser Client="Musiver", Device="Mi-Mini-M2", Version="1.3.9", Token="${authPayload.AccessToken}"`
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run('virtual.song.003CnoIy3AcyPE', JSON.stringify({
      song: {
        source: 'tx',
        songmid: '003CnoIy3AcyPE',
        name: '天公疼憨人',
        singer: '曾心梅',
        albumName: '天公疼憨人',
        albumId: '001ujqZ31d05Tm',
        interval: '4:22',
        types: [{ type: '128k', size: '4.01MB' }],
        raw: { songId: 104833610, strMediaMid: '000Tgfyk3sAoaL' },
      },
    }))

    const requestedQualities: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'script.example') {
        if (requestUrl.searchParams.get('action') === 'musicUrl') {
          requestedQualities.push(requestUrl.searchParams.get('quality') ?? '')
        }
        return new Response('https://cdn.example/audio.mp3')
      }
      if (requestUrl.hostname === 'cdn.example') {
        return new Response('audio-bytes', { headers: { 'content-type': 'audio/mpeg' } })
      }
      if (requestUrl.hostname === 'stat6.y.qq.com') return new Response('{}')
      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/Audio/${encodeURIComponent(songId)}/stream?UserId=${authPayload.User.Id}&Container=mp3&AudioCodec=mp3&api_key=${authPayload.AccessToken}`, {
        headers: { authorization: authHeader, 'user-agent': 'musiver/1.3.9 (Macintosh)' },
      }),
      stripOptionalEmbyPrefix(`/Audio/${encodeURIComponent(songId)}/stream`),
    )
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'audio-bytes')
    assert.deepEqual(requestedQualities, ['128k'])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999032')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('virtual.song.003CnoIy3AcyPE')
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run('003CnoIy3AcyPE')
    db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track' AND json_extract(payload_json, '$.songmid') = ?").run('003CnoIy3AcyPE')
    globalThis.fetch = originalFetch
    if (originalLxMusicSourceScript === undefined) {
      delete process.env.LX_MUSIC_SOURCE_SCRIPT
    } else {
      process.env.LX_MUSIC_SOURCE_SCRIPT = originalLxMusicSourceScript
    }
  }
})

test('local emby virtual playback reports are consumed locally', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999010')
    saveQQLoginCookie('uin=o999010; qm_keyst=test-key')
    markAccountUpstreamBound('999010')
    const account = getAccountByQQ('999010')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const playlistId = encodeVirtualId({ kind: 'qq-daily' })
    const songId = encodeVirtualId({ kind: 'qq-song', songmid: 'qq-report-song-1', playlistId })
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`

    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run('virtual.song.qq-report-song-1', JSON.stringify({
      playlistId,
      song: {
        source: 'tx',
        songmid: 'qq-report-song-1',
        name: 'QQ Report Song',
        singer: 'QQ Artist',
        albumName: 'QQ Album',
        albumId: 'qq-album',
        interval: '03:08',
        types: [{ type: '320k', size: '1 MB' }],
      },
    }))

    const upstreamRequests: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      upstreamRequests.push(String(url))
      return Response.json({ error: 'virtual id leaked upstream' }, { status: 500 })
    }) as typeof fetch

    for (const path of ['/emby/Sessions/Playing', '/emby/Sessions/Playing/Stopped']) {
      const response = await dispatchEmbyRequest(
        new Request(`http://local${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Emby-Authorization': authHeader,
          },
          body: JSON.stringify({
            ItemId: songId,
            IsPaused: false,
            PositionTicks: 0,
            PlaySessionId: 'test-session',
          }),
        }),
        stripOptionalEmbyPrefix(path),
      )
      assert.equal(response.status, 204)
    }

    assert.deepEqual(upstreamRequests, [])
    const syncJob = db.prepare(`
      SELECT id
      FROM jobs
      WHERE type = 'sync_emby_track'
        AND json_extract(payload_json, '$.songmid') = ?
      LIMIT 1
    `).get('qq-report-song-1')
    assert.equal(syncJob, undefined)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999010')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('virtual.song.qq-report-song-1')
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run('qq-report-song-1')
    globalThis.fetch = originalFetch
  }
})

test('local emby image requests proxy upstream images for real Emby ids', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999007')
    saveQQLoginCookie('uin=o999007; qm_keyst=test-key')
    markAccountUpstreamBound('999007')
    const account = getAccountByQQ('999007')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()

    const upstreamRequests: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      upstreamRequests.push(String(url))
      return new Response('image-bytes', {
        headers: { 'content-type': 'image/jpeg' },
      })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request('http://local/emby/Items/11696869/Images/Primary?maxWidth=480&maxHeight=480', {
        headers: {
          'X-Emby-Authorization': `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`,
        },
      }),
      stripOptionalEmbyPrefix('/emby/Items/11696869/Images/Primary'),
    )

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/jpeg')
    assert.equal(await response.text(), 'image-bytes')
    assert.equal(upstreamRequests.length, 1)
    assert.ok(new URL(upstreamRequests[0]!).pathname.endsWith('/Items/11696869/Images/Primary'))
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999007')
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('local emby image requests fetch cached QQ virtual artwork', async () => {
  const originalFetch = globalThis.fetch
  try {
    const virtualId = encodeVirtualId({ kind: 'qq-song', songmid: 'qq-image-song' })
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run('virtual.song.qq-image-song', JSON.stringify({
      song: {
        source: 'tx',
        songmid: 'qq-image-song',
        name: 'QQ Image Song',
        singer: 'QQ Artist',
        albumName: 'QQ Album',
        albumId: 'qq-album',
        img: 'https://img.example/qq-image.jpg',
        interval: '03:00',
        types: [],
      },
    }))

    const imageRequests: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      imageRequests.push(String(url))
      return new Response('qq-image-bytes', {
        headers: { 'content-type': 'image/png' },
      })
    }) as typeof fetch

    db.prepare('DELETE FROM resource_cache WHERE url = ?').run('https://img.example/qq-image.jpg')
    rmSync(join(process.env.MUSIC_DATA_DIR ?? './data', 'resources', 'image'), { recursive: true, force: true })

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Items/${encodeURIComponent(virtualId)}/Images/Primary?maxWidth=480&maxHeight=480`),
      stripOptionalEmbyPrefix(`/emby/Items/${encodeURIComponent(virtualId)}/Images/Primary`),
    )

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.equal(await response.text(), 'qq-image-bytes')
    assert.deepEqual(imageRequests, ['https://img.example/qq-image.jpg'])
    await waitFor(() => Boolean(db.prepare('SELECT 1 FROM resource_cache WHERE url = ?').get('https://img.example/qq-image.jpg')))

    const cached = await dispatchEmbyRequest(
      new Request(`http://local/emby/Items/${encodeURIComponent(virtualId)}/Images/Primary?maxWidth=480&maxHeight=480`),
      stripOptionalEmbyPrefix(`/emby/Items/${encodeURIComponent(virtualId)}/Images/Primary`),
    )
    assert.equal(cached.status, 200)
    assert.equal(await cached.text(), 'qq-image-bytes')
    assert.equal(imageRequests.length, 1)

    const tagged = await dispatchEmbyRequest(
      new Request(`http://local/emby/Items/${encodeURIComponent(virtualId)}/Images/Primary/${encodeURIComponent(virtualId)}?maxWidth=480&maxHeight=480`),
      stripOptionalEmbyPrefix(`/emby/Items/${encodeURIComponent(virtualId)}/Images/Primary/${encodeURIComponent(virtualId)}`),
    )
    assert.equal(tagged.status, 200)
    assert.equal(await tagged.text(), 'qq-image-bytes')
    assert.equal(imageRequests.length, 1)
  } finally {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('virtual.song.qq-image-song')
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('virtual.song.qq-stream-song-1')
    db.prepare('DELETE FROM resource_cache WHERE url = ?').run('https://img.example/qq-image.jpg')
    globalThis.fetch = originalFetch
  }
})

test('local emby library exploration endpoints proxy upstream and fall back to empty collections', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999004')
    saveQQLoginCookie('uin=o999004; qm_keyst=test-key')
    markAccountUpstreamBound('999004')
    const account = getAccountByQQ('999004')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`

    const upstreamRequests: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      upstreamRequests.push(String(url))
      return Response.json({
        Items: [{ Id: 'emby-upstream-item', Name: 'Upstream Item', Type: 'MusicAlbum' }],
        TotalRecordCount: 1,
      })
    }) as typeof fetch

    for (const path of [
      `/emby/Users/${authPayload.User.Id}/Albums`,
      `/emby/Users/${authPayload.User.Id}/Artists`,
      `/emby/Users/${authPayload.User.Id}/AlbumArtists`,
      `/emby/Users/${authPayload.User.Id}/Genres`,
      `/emby/Users/${authPayload.User.Id}/Items/Latest`,
      `/emby/Users/${authPayload.User.Id}/Items/Resume`,
      `/emby/Artists`,
      `/emby/AlbumArtists`,
      `/emby/Artists/AlbumArtists?IncludeItemTypes=Audio&Fields=AudioInfo%2CChildCount%2CDateCreated%2CGenres%2CMediaSources%2CParentIndexNumber%2CPath%2CProductionYear%2CPremiereDate%2COverview%2CPresentationUniqueKey%2CProviderIds%2CUserDataPlayCount%2CUserDataLastPlayedDate&EnableUserData=true&Recursive=true&ImageTypeLimit=1&EnableImageTypes=Primary&EnableTotalRecordCount=true&ParentId=x-music-music&isFavorite=true&UserId=${authPayload.User.Id}&Limit=500&StartIndex=0`,
      `/emby/Albums`,
      `/emby/Genres?UserId=${authPayload.User.Id}&ParentId=x-music-music&IncludeItemTypes=MusicAlbum&SortBy=SortName&Recursive=true&Limit=500&StartIndex=0&EnableImages=false&EnableUserData=false&EnableTotalRecordCount=false`,
      `/emby/Years?UserId=${authPayload.User.Id}&ParentId=x-music-music&IncludeItemTypes=MusicAlbum&SortBy=SortName&Recursive=true&Limit=500&StartIndex=0&EnableImages=false&EnableUserData=false&EnableTotalRecordCount=false`,
    ]) {
      const embyPath = path.split('?')[0] ?? path
      const response = await dispatchEmbyRequest(
        new Request(`http://local${path}`, { headers: { 'X-Emby-Authorization': authHeader } }),
        stripOptionalEmbyPrefix(embyPath),
      )
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), {
        Items: [{ Id: 'emby-upstream-item', Name: 'Upstream Item', Type: 'MusicAlbum' }],
        TotalRecordCount: 1,
      })
    }
    assert.ok(upstreamRequests.length >= 1)
    assert.ok(upstreamRequests.every(url => !new URL(url).searchParams.has('ParentId')))

    globalThis.fetch = (async () => Response.json({ error: 'upstream failed' }, { status: 500 })) as typeof fetch

    const fallbackQueries = [
      'IncludeItemTypes=Audio&Fields=AudioInfo%2CChildCount%2CDateCreated%2CGenres%2CMediaSources%2CParentIndexNumber%2CPath%2CProductionYear%2CPremiereDate%2COverview%2CPresentationUniqueKey%2CProviderIds%2CUserDataPlayCount%2CUserDataLastPlayedDate&EnableUserData=true&Recursive=true&ImageTypeLimit=1&EnableImageTypes=Primary&EnableTotalRecordCount=true&ParentId=x-music-music&Filters=IsPlayed&SortBy=PlayCount%2CDatePlayed&SortOrder=Descending&Limit=500&StartIndex=0',
      'IncludeItemTypes=Audio&Fields=AudioInfo%2CChildCount%2CDateCreated%2CGenres%2CMediaSources%2CParentIndexNumber%2CPath%2CProductionYear%2CPremiereDate%2COverview%2CPresentationUniqueKey%2CProviderIds%2CUserDataPlayCount%2CUserDataLastPlayedDate&EnableUserData=true&Recursive=true&ImageTypeLimit=1&EnableImageTypes=Primary&EnableTotalRecordCount=true&ParentId=x-music-music&Filters=IsFavorite&SortBy=AlbumArtist%2CAlbum%2CParentIndexNumber%2CIndexNumber%2CSortName&SortOrder=Ascending&Limit=500&StartIndex=0',
      'IncludeItemTypes=MusicAlbum&Fields=AudioInfo%2CChildCount%2CDateCreated%2CGenres%2CMediaSources%2CParentIndexNumber%2CPath%2CProductionYear%2CPremiereDate%2COverview%2CPresentationUniqueKey%2CProviderIds%2CUserDataPlayCount%2CUserDataLastPlayedDate&EnableUserData=true&Recursive=true&ImageTypeLimit=1&EnableImageTypes=Primary&EnableTotalRecordCount=true&ParentId=x-music-music&SortBy=DateCreated%2CSortName&SortOrder=Descending%2CAscending&Limit=500&StartIndex=0',
      'IncludeItemTypes=Audio&Fields=AudioInfo%2CChildCount%2CDateCreated%2CGenres%2CMediaSources%2CParentIndexNumber%2CPath%2CProductionYear%2CPremiereDate%2COverview%2CPresentationUniqueKey%2CProviderIds%2CUserDataPlayCount%2CUserDataLastPlayedDate&EnableUserData=true&Recursive=true&ImageTypeLimit=1&EnableImageTypes=Primary&EnableTotalRecordCount=true&ParentId=x-music-music&SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed&Limit=200&StartIndex=0',
      'IncludeItemTypes=Audio&Fields=AudioInfo%2CChildCount%2CDateCreated%2CGenres%2CMediaSources%2CParentIndexNumber%2CPath%2CProductionYear%2CPremiereDate%2COverview%2CPresentationUniqueKey%2CProviderIds%2CUserDataPlayCount%2CUserDataLastPlayedDate&EnableUserData=true&Recursive=true&ImageTypeLimit=1&EnableImageTypes=Primary&EnableTotalRecordCount=true&ParentId=x-music-music&SortBy=Random&Limit=100&StartIndex=0',
      'IncludeItemTypes=MusicAlbum&Fields=AudioInfo%2CChildCount%2CDateCreated%2CGenres%2CMediaSources%2CParentIndexNumber%2CPath%2CProductionYear%2CPremiereDate%2COverview%2CPresentationUniqueKey%2CProviderIds%2CUserDataPlayCount%2CUserDataLastPlayedDate&EnableUserData=true&Recursive=true&ImageTypeLimit=1&EnableImageTypes=Primary&EnableTotalRecordCount=true&ParentId=x-music-music&SortBy=Random&Limit=100&StartIndex=0',
    ]
    for (const query of fallbackQueries) {
      const response = await dispatchEmbyRequest(
        new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?${query}`, { headers: { 'X-Emby-Authorization': authHeader } }),
        stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
      )
      assert.equal(response.status, 200)
      const payload = await response.json()
      if (query.includes('Filters=IsPlayed')) {
        assert.ok(Array.isArray(payload.Items))
        assert.equal(typeof payload.TotalRecordCount, 'number')
      } else if (query.includes('Filters=IsFavorite') && query.includes('IncludeItemTypes=Audio')) {
        assert.deepEqual(payload, { Items: [], TotalRecordCount: 999 })
      } else {
        assert.deepEqual(payload, { Items: [], TotalRecordCount: 0 })
      }
    }

    const playlists = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Playlist&Fields=AudioInfo%2CChildCount%2CDateCreated%2CGenres%2CMediaSources%2CParentIndexNumber%2CPath%2CProductionYear%2CPremiereDate%2COverview%2CPresentationUniqueKey%2CProviderIds%2CUserDataPlayCount%2CUserDataLastPlayedDate&EnableUserData=true&Recursive=true&ImageTypeLimit=1&EnableImageTypes=Primary&EnableTotalRecordCount=true&ParentId=x-music-music&SortBy=SortName&SortOrder=Ascending&Limit=500&StartIndex=0`, { headers: { 'X-Emby-Authorization': authHeader } }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(playlists.status, 200)
    const playlistsPayload = await playlists.json()
    assert.equal(playlistsPayload.TotalRecordCount, 2)
    assert.deepEqual(playlistsPayload.Items.map((item: { Name: string }) => item.Name), ['QQ 每日推荐', 'QQ 猜你喜欢'])
    for (const item of playlistsPayload.Items) {
      assert.equal(typeof item.DateCreated, 'string')
      assert.equal(typeof item.DateLastMediaAdded, 'string')
      assert.equal(typeof item.UserData.LastPlayedDate, 'string')
      assert.ok(Date.parse(item.DateCreated) > Date.now() - 60_000)
      assert.ok(item.UserData.PlayCount > 0)
    }

    const image = await dispatchEmbyRequest(
      new Request('http://local/emby/Items/x-music-music/Images/Primary', { headers: { 'X-Emby-Authorization': authHeader } }),
      stripOptionalEmbyPrefix('/emby/Items/x-music-music/Images/Primary'),
    )
    assert.equal(image.status, 204)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999004')
    clearUpstreamMusicLibraryCache()
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('virtual emby ids round-trip structured ids', () => {
  const id = encodeVirtualId({ kind: 'qq-song', songmid: 'abc', playlistId: 'list1' })
  assert.deepEqual(decodeVirtualId(id), { kind: 'qq-song', songmid: 'abc', playlistId: 'list1' })
})

test('QQ song virtual ids are stable across playlists by default', () => {
  const song = {
    source: 'tx' as const,
    songmid: 'stable-song',
    name: 'Stable Song',
    singer: 'Artist',
  }
  assert.equal(songVirtualId(song), songVirtualId(song, encodeVirtualId({ kind: 'qq-playlist', id: 'playlist-a' })))
  assert.deepEqual(decodeVirtualId(songVirtualId(song)), { kind: 'qq-song', songmid: 'stable-song' })
})

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
