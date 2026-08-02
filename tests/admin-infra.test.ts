import assert from 'node:assert/strict'
import test from 'node:test'
import crypto from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { db } from '@/lib/db'
import { appConfig } from '@/lib/config'
import { deleteSetting, getEffectiveSettings, getSetting, setSetting, updateEffectiveSettings } from '@/lib/db/settings'
import { getAccountByQQ, getAccountDetail, listAccountSummaries, markAccountActive, updateAccountEmbyConfig } from '@/lib/db/accounts'
import { clearQQLoginCookie, saveQQLoginCookie } from '@/lib/db/qq-session'
import { dispatchEmbyRequest } from '@/lib/emby/dispatch'
import { ensureUpstreamEmbyUserForAccount } from '@/lib/emby/auth'
import { handleLocalEmbyRequest } from '@/lib/emby/local-handlers'
import { normalizeEmbyPath, stripOptionalEmbyPrefix } from '@/lib/emby/paths'
import { proxyToUpstreamEmby } from '@/lib/emby/upstream-proxy'
import { embyConfigForAccount, hasAccountUpstreamEmby } from '@/lib/emby/config'
import { ampcastAutoConnectConfig, ampcastAutoInitHtml, playerPathFromEmbyPath, proxyToAmpcast } from '@/lib/ampcast/proxy'
import { createLocalAccessToken, readEmbyAccessToken } from '@/lib/emby/tokens'
import { decodeVirtualId, encodeVirtualId, songVirtualId } from '@/lib/emby/virtual-ids'
import { getFavoriteStatus, setLocalFavoriteSynced } from '@/lib/db/favorites'
import { upsertRemoteMapping } from '@/lib/db/remote-mappings'
import { updateAccountEmbyPassword } from '@/lib/db/accounts'
import { ensureTrack, insertPlayEvent, upsertTrackFileStatus } from '@/lib/cache/store'
import type { MusicInfo } from '@/lib/types'
import { syncMappedEmbyFavoriteBestEffort } from '@/lib/emby/favorites'
import { logCompletedRequest, logFailedRequest, logServiceEvent, requestLoggingEnabled, safeRequestPath } from '@/lib/request-log'
import { QQAuthExpiredError, requireActiveQQAccount } from '@/lib/qq/auth-state'
import { requestUserTrackSync } from '@/lib/emby/sync'

function markAccountUpstreamBound(qqUin: string, embyUserId = `emby-user-${qqUin}`, embyAccessToken?: string): void {
  configureAccountUpstreamEmby(qqUin)
  db.prepare(`
    UPDATE accounts
    SET emby_user_id = ?,
        emby_access_token = COALESCE(?, emby_access_token)
    WHERE qq_uin = ?
  `).run(embyUserId, embyAccessToken ?? null, qqUin)
}

function configureAccountUpstreamEmby(qqUin: string): void {
  db.prepare(`
    UPDATE accounts
    SET
        emby_dsn = 'http://admin:secret@127.0.0.1:8096',
        emby_proxy_timeout_ms = 30000
    WHERE qq_uin = ?
  `).run(qqUin)
}

function configureAccountUpstreamWebdav(qqUin: string): void {
  db.prepare(`
    UPDATE accounts
    SET emby_source_webdav_dsn = 'https://webdav-user:webdav-pass@webdav.example/dav/music'
    WHERE qq_uin = ?
  `).run(qqUin)
}

function localEmbyRequestForAccount(account: NonNullable<ReturnType<typeof getAccountByQQ>>, url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  headers.set('X-Emby-Token', createLocalAccessToken(account))
  return new Request(url, { ...init, headers })
}

function clearUpstreamMusicLibraryCache(): void {
  db.prepare("DELETE FROM app_settings WHERE key IN ('emby.upstreamMusicLibraryMapping', 'emby.upstreamMusicLibraryIds')").run()
}

function rememberTestVirtualSong(song: MusicInfo): void {
  db.prepare(`
    INSERT INTO app_settings (key, value_json, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
  `).run(`virtual.song.${song.songmid}`, JSON.stringify({ song }))
}

function qqRadioSessionResponse(): Response {
  return Response.json({
    code: 0,
    req: {
      code: 0,
      data: { session: { uid: 'device-session-uid', sid: 'device-session-sid' } },
    },
  })
}

test('settings store persists typed values and merges effective defaults', () => {
  deleteSetting('qq.enabled')
  assert.equal(getSetting('qq.enabled'), undefined)

  setSetting('qq.enabled', false)
  assert.equal(getSetting('qq.enabled'), false)
  assert.equal(getEffectiveSettings().qq.enabled, false)

  deleteSetting('qq.enabled')
})

test('persisted user roles control account permissions and summaries', () => {
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin IN (?, ?)').run('123456', '999777')

    saveQQLoginCookie('uin=o123456; qm_keyst=test-key')
    saveQQLoginCookie('uin=o999777; qm_keyst=test-key')
    db.prepare("UPDATE users SET role = 'admin' WHERE id IN ('123456', '999777')").run()
    markAccountActive('123456')

    const users = listAccountSummaries().filter(user => user.qqUin === '123456' || user.qqUin === '999777')
    assert.equal(users.length, 2)
    assert.ok(users.every(user => user.isAdmin))
    assert.ok(users.find(user => user.qqUin === '123456')?.lastActiveAt)
  } finally {
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

    logServiceEvent('virtual_audio_playback_failed', { songmid: 'song-1', error: 'upstream returned 404' }, 'error')
    assert.equal(errorMessages.length, 3)
    const eventPayload = JSON.parse(errorMessages[2]!) as Record<string, unknown>
    assert.equal(eventPayload.event, 'virtual_audio_playback_failed')
    assert.equal(eventPayload.songmid, 'song-1')
    assert.equal(eventPayload.error, 'upstream returned 404')
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

test('catch-all route handles apple touch icon probes locally', async () => {
  const route = await import('@/app/[...path]/route')
  const originalFetch = globalThis.fetch
  try {
    let upstreamRequests = 0
    globalThis.fetch = (async () => {
      upstreamRequests += 1
      return Response.json({ error: 'should not proxy apple icon' }, { status: 500 })
    }) as typeof fetch

    const response = await route.GET(new Request('http://local/apple-touch-icon-120x120-precomposed.png'), {
      params: Promise.resolve({ path: ['apple-touch-icon-120x120-precomposed.png'] }),
    })

    assert.equal(response.status, 404)
    assert.equal(response.headers.get('cache-control'), 'public, max-age=86400')
    assert.equal(upstreamRequests, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('catch-all route proxies ampcast player and manifest without an XMusic session', async () => {
  const route = await import('@/app/[...path]/route')
  const originalFetch = globalThis.fetch
  clearQQLoginCookie()
  try {
    let upstreamRequests = 0
    globalThis.fetch = (async (url: string | URL | Request) => {
      upstreamRequests += 1
      if (!new URL(url.toString()).pathname.endsWith('/manifest.json')) {
        return new Response('<main>ampcast player</main>', {
          headers: { 'content-type': 'text/html' },
        })
      }
      return Response.json({ name: 'ampcast', start_url: '/' }, {
        headers: { 'content-type': 'application/manifest+json' },
      })
    }) as typeof fetch

    const playerResponse = await route.GET(new Request('http://local/@player'), {
      params: Promise.resolve({ path: ['@player'] }),
    })
    const manifestResponse = await route.GET(new Request('http://local/@player/manifest.json'), {
      params: Promise.resolve({ path: ['@player', 'manifest.json'] }),
    })

    assert.equal(playerResponse.status, 200)
    assert.match(await playerResponse.text(), /ampcast player/)
    assert.equal(manifestResponse.status, 200)
    assert.equal(upstreamRequests, 2)
    assert.equal((await manifestResponse.json()).start_url, '/@player/auto-init')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('ampcast auto-init redirects anonymous users to the regular player', async () => {
  const route = await import('@/app/[...path]/route')
  clearQQLoginCookie()

  const response = await route.GET(new Request('http://local/@player/auto-init'), {
    params: Promise.resolve({ path: ['@player', 'auto-init'] }),
  })

  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), '/@player')
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('ampcast auto-init keeps automatic XMusic configuration for signed-in users', async () => {
  const route = await import('@/app/[...path]/route')
  db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('555779')
  try {
    saveQQLoginCookie('uin=o555779; qm_keyst=test-key')

    const response = await route.GET(new Request('http://local/@player/auto-init'), {
      params: Promise.resolve({ path: ['@player', 'auto-init'] }),
    })
    const body = await response.text()

    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/html/)
    assert.match(body, /"userName":"QQ555779"/)
    assert.match(body, /localStorage\.setItem\(prefix \+ 'token', config\.token\)/)
    assert.match(body, /window\.location\.replace\('\/@player'\)/)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('555779')
    clearQQLoginCookie()
  }
})

test('test compatibility QQ login creates a user-scoped Emby gateway account', () => {
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

test('explicit QQ refresh rejection expires the bound account auth state', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999905')
    saveQQLoginCookie('uin=o999905; qm_keyst=test-key')
    const account = getAccountByQQ('999905')
    assert.ok(account)

    globalThis.fetch = (async () => Response.json({ code: -1000, message: '请登录' })) as typeof fetch

    await assert.rejects(
      () => requireActiveQQAccount(account, { force: true }),
      QQAuthExpiredError,
    )
    const updated = getAccountByQQ('999905')
    assert.equal(updated?.qqAuthState, 'expired')
    assert.equal(updated?.qqAuthError, 'QQ Music key refresh failed')
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999905')
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('upstream emby account creation uses the XMusic username and restricts access to music library', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999019')
    saveQQLoginCookie('uin=o999019; qm_keyst=test-key')
    configureAccountUpstreamEmby('999019')
    const account = getAccountByQQ('999019')
    assert.ok(account)

    const requests: Array<{ url: URL; init?: RequestInit; body?: Record<string, unknown> }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
      requests.push({ url: requestUrl, init, body })

      if (requestUrl.pathname.endsWith('/Users/New')) return Response.json({ Id: 'emby-user-999019', Name: body?.Name })
      if (requestUrl.pathname.endsWith('/Users')) return Response.json([])
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
    configureAccountUpstreamEmby('999021')
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
    configureAccountUpstreamEmby('999024')
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
    markAccountUpstreamBound('999020', 'emby-user-999020')
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
  assert.equal(normalizeEmbyPath(['emby', 'Audio', 'mix_song', 'universal']), '/Audio/mix_song/universal')
  assert.equal(normalizeEmbyPath(['emby', 'Items', 'mix_song', 'Lyrics']), '/Items/mix_song/Lyrics')
  assert.equal(normalizeEmbyPath(['emby', 'System', 'Info', 'Public']), '/System/Info/Public')
})

test('ampcast player path maps to embedded proxy route', () => {
  assert.equal(playerPathFromEmbyPath('/@player'), '/')
  assert.equal(playerPathFromEmbyPath('/@Player'), '/')
  assert.equal(playerPathFromEmbyPath('/@player/auto-init'), undefined)
  assert.equal(playerPathFromEmbyPath('/@player/assets/app.js'), '/assets/app.js')
  assert.equal(playerPathFromEmbyPath(normalizeEmbyPath(['@player'])), '/')
  assert.equal(playerPathFromEmbyPath(normalizeEmbyPath(['@player', 'assets', 'app.js'])), '/assets/app.js')
  assert.equal(playerPathFromEmbyPath('/v0.9.28/lib/media-services.js'), '/v0.9.28/lib/media-services.js')
  assert.equal(playerPathFromEmbyPath('/service-worker-v2.js'), '/service-worker-v2.js')
  assert.equal(playerPathFromEmbyPath('/Items'), undefined)
})

test('ampcast auto-init html stores local config and redirects to embedded player', () => {
  const body = ampcastAutoInitHtml(ampcastAutoConnectConfig({
    userId: 'test-user-555777',
    embyUsername: 'player-user',
  }, 'http://local'))

  assert.match(body, /const currentHost = window\.location\.origin/)
  assert.match(body, /localStorage\.setItem\(prefix \+ 'host', currentHost\)/)
  assert.match(body, /"host":"http:\/\/local"/)
  assert.match(body, /"userName":"player-user"/)
  assert.match(body, new RegExp(`"userId":"${crypto.createHash('sha256').update('x-music:emby-user:test-user-555777').digest('hex').slice(0, 32)}"`))
  assert.match(body, /"libraryId":"x-music-music"/)
  assert.match(body, /localStorage\.setItem\(prefix \+ 'deviceId', deviceId\)/)
  assert.match(body, /localStorage\.setItem\(prefix \+ 'isLocal', 'true'\)/)
  assert.match(body, /localStorage\.setItem\('ampcast\/installed-version', '0\.9\.28'\)/)
  assert.match(body, /localStorage\.setItem\('ampcast\/playback\/repeatMode', localStorage\.getItem\('ampcast\/playback\/repeatMode'\) \|\| '0'\)/)
  assert.match(body, /localStorage\.setItem\('ampcast\/services\/fields', localStorage\.getItem\('ampcast\/services\/fields'\) \|\| ''\)/)
  assert.match(body, /const hiddenServices = \{"spotify\/charts":true/)
  assert.match(body, /"emby":false/)
  assert.match(body, /"subsonic":true/)
  assert.match(body, /localStorage\.setItem\('ampcast\/services\/hidden', JSON\.stringify\(hiddenServices\)\)/)
  assert.match(body, /localStorage\.setItem\('ampcast\/sources\/selectedId', config\.service\)/)
  assert.match(body, /requestAnimationFrame\(\(\) => window\.location\.replace\('\/@player'\)\)/)
})

test('ampcast auto-init credentials pass startup validation requests', async () => {
  db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('555778')
  try {
    saveQQLoginCookie('uin=o555778; qm_keyst=test-key')
    const account = getAccountByQQ('555778')
    assert.ok(account)

    const config = ampcastAutoConnectConfig(account, 'http://local')
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", DeviceId="test-device", Token="${config.token}"`
    const endpoint = await handleLocalEmbyRequest(new Request('http://local/emby/System/Endpoint', {
      headers: { 'X-Emby-Authorization': authHeader },
    }), stripOptionalEmbyPrefix('/emby/System/Endpoint'))
    assert.equal(endpoint?.status, 200)

    const views = await handleLocalEmbyRequest(new Request(`http://local/emby/Users/${config.userId}/Views`, {
      headers: { 'X-Emby-Authorization': authHeader },
    }), stripOptionalEmbyPrefix(`/emby/Users/${config.userId}/Views`))
    assert.equal(views?.status, 200)
    const viewsPayload = await views!.json()
    assert.equal(viewsPayload.Items?.[0]?.Id, 'x-music-music')
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('555778')
    clearQQLoginCookie()
  }
})

test('ampcast proxy forwards to configured upstream and rewrites embedded assets', async () => {
  const originalFetch = globalThis.fetch
  const originalAmpcastUrl = process.env.AMPCAST_URL
  try {
    delete process.env.AMPCAST_URL
    let forwardedUrl = ''
    globalThis.fetch = (async (url: string | URL | Request) => {
      forwardedUrl = url.toString()
      return new Response('<script src="/assets/app.js"></script><link href="/style.css"><script>import("/v0.9.28/lib/media-services.js")</script><main action="/login"></main>', {
        headers: {
          'content-type': 'text/html',
          'content-encoding': 'br',
          'content-length': '99',
          'x-frame-options': 'DENY',
        },
      })
    }) as typeof fetch

    const response = await proxyToAmpcast(new Request('http://local/@player/?theme=dark'), '/')
    const text = await response.text()

    assert.equal(forwardedUrl, 'http://ampcast:8000/?theme=dark')
    assert.equal(response.headers.get('content-encoding'), null)
    assert.equal(response.headers.get('content-length'), null)
    assert.equal(response.headers.get('x-frame-options'), null)
    assert.match(text, /src="\/@player\/assets\/app\.js"/)
    assert.match(text, /href="\/@player\/style\.css"/)
    assert.match(text, /"\/@player\/v0\.9\.28\/lib\/media-services\.js"/)
    assert.match(text, /action="\/@player\/login"/)
  } finally {
    globalThis.fetch = originalFetch
    if (originalAmpcastUrl === undefined) delete process.env.AMPCAST_URL
    else process.env.AMPCAST_URL = originalAmpcastUrl
  }
})

test('ampcast proxy rewrites manifest startup into the player scope', async () => {
  const originalFetch = globalThis.fetch
  const originalAmpcastUrl = process.env.AMPCAST_URL
  try {
    delete process.env.AMPCAST_URL
    globalThis.fetch = (async () => Response.json({
      name: 'ampcast',
      start_url: '/',
      icons: [{ src: 'icon-192.png', sizes: '192x192' }],
      shortcuts: [{ name: 'Library', url: '/library', icons: [{ src: '/icons/library.png' }] }],
    }, {
      headers: { 'content-type': 'application/manifest+json' },
    })) as typeof fetch

    const response = await proxyToAmpcast(new Request('http://local/@player/manifest.json'), '/manifest.json')
    const manifest = await response.json() as {
      id?: string
      start_url?: string
      scope?: string
      icons?: Array<{ src?: string }>
      shortcuts?: Array<{ url?: string; icons?: Array<{ src?: string }> }>
    }

    assert.equal(manifest.id, '/')
    assert.equal(manifest.start_url, '/@player/auto-init')
    assert.equal(manifest.scope, '/@player')
    assert.equal(manifest.icons?.[0]?.src, '/@player/icon-192.png')
    assert.equal(manifest.shortcuts?.[0]?.url, '/@player/library')
    assert.equal(manifest.shortcuts?.[0]?.icons?.[0]?.src, '/@player/icons/library.png')
  } finally {
    globalThis.fetch = originalFetch
    if (originalAmpcastUrl === undefined) delete process.env.AMPCAST_URL
    else process.env.AMPCAST_URL = originalAmpcastUrl
  }
})

test('ampcast proxy returns friendly unavailable page when upstream fails', async () => {
  const originalFetch = globalThis.fetch
  const originalAmpcastUrl = process.env.AMPCAST_URL
  try {
    delete process.env.AMPCAST_URL
    globalThis.fetch = (async () => {
      throw new TypeError('connect failed')
    }) as typeof fetch

    const response = await proxyToAmpcast(new Request('http://local/@player/', {
      headers: { accept: 'text/html' },
    }), '/')
    const body = await response.text()

    assert.equal(response.status, 502)
    assert.match(response.headers.get('content-type') ?? '', /text\/html/)
    assert.match(body, /播放器暂时不可用/)
    assert.match(body, /请检查上游 ampcast 服务状态/)
    assert.match(body, /http:\/\/ampcast:8000\//)
  } finally {
    globalThis.fetch = originalFetch
    if (originalAmpcastUrl === undefined) delete process.env.AMPCAST_URL
    else process.env.AMPCAST_URL = originalAmpcastUrl
  }
})

test('ampcast proxy maps root versioned assets to the configured upstream', async () => {
  const originalFetch = globalThis.fetch
  const originalAmpcastUrl = process.env.AMPCAST_URL
  try {
    delete process.env.AMPCAST_URL
    let forwardedUrl = ''
    globalThis.fetch = (async (url: string | URL | Request) => {
      forwardedUrl = url.toString()
      return new Response('console.log("media")', {
        headers: { 'content-type': 'application/javascript' },
      })
    }) as typeof fetch

    const response = await proxyToAmpcast(new Request('http://local/v0.9.28/lib/media-services.js'), '/v0.9.28/lib/media-services.js')

    assert.equal(forwardedUrl, 'http://ampcast:8000/v0.9.28/lib/media-services.js')
    assert.equal(response.headers.get('content-type'), 'application/javascript')
    assert.equal(await response.text(), 'console.log("media")')
  } finally {
    globalThis.fetch = originalFetch
    if (originalAmpcastUrl === undefined) delete process.env.AMPCAST_URL
    else process.env.AMPCAST_URL = originalAmpcastUrl
  }
})

test('ampcast proxy uses optional AMPCAST_URL environment override', async () => {
  const originalFetch = globalThis.fetch
  const originalAmpcastUrl = process.env.AMPCAST_URL
  try {
    process.env.AMPCAST_URL = 'https://legacy-ampcast.example/'
    let forwardedUrl = ''
    globalThis.fetch = (async (url: string | URL | Request) => {
      forwardedUrl = url.toString()
      return new Response('<main></main>', {
        headers: { 'content-type': 'text/html' },
      })
    }) as typeof fetch

    await proxyToAmpcast(new Request('http://local/@player/'), '/')

    assert.equal(forwardedUrl, 'https://legacy-ampcast.example/')
  } finally {
    if (originalAmpcastUrl === undefined) {
      delete process.env.AMPCAST_URL
    } else {
      process.env.AMPCAST_URL = originalAmpcastUrl
    }
    globalThis.fetch = originalFetch
  }
})

test('local emby public info supports original emby routes', async () => {
  const response = await handleLocalEmbyRequest(new Request('http://local/System/Info/Public'), '/System/Info/Public')
  assert.equal(response?.status, 200)
  const payload = await response!.json()
  assert.equal(payload.ServerName, 'XMusic')
})

test('local emby system info supports prefixed client probe route', async () => {
  const response = await handleLocalEmbyRequest(
    new Request('http://local/emby/System/Info'),
    stripOptionalEmbyPrefix('/emby/System/Info'),
  )
  assert.equal(response?.status, 200)
  const payload = await response!.json()
  assert.equal(payload.ServerName, 'XMusic')
  assert.equal(payload.Id, 'x-music')
})

test('local emby startup probes return compatibility payloads', async () => {
  const config = await handleLocalEmbyRequest(
    new Request('http://local/emby/System/Configuration'),
    stripOptionalEmbyPrefix('/emby/System/Configuration'),
  )
  assert.equal(config?.status, 200)
  assert.equal((await config!.json()).ServerName, 'XMusic')

  const ping = await handleLocalEmbyRequest(
    new Request('http://local/emby/System/Ping'),
    stripOptionalEmbyPrefix('/emby/System/Ping'),
  )
  assert.equal(ping?.status, 200)
  assert.equal(await ping!.text(), 'XMusic')

  const branding = await handleLocalEmbyRequest(
    new Request('http://local/emby/Branding/Configuration'),
    stripOptionalEmbyPrefix('/emby/Branding/Configuration'),
  )
  assert.equal(branding?.status, 200)
  assert.equal((await branding!.json()).SplashscreenEnabled, false)

  const css = await handleLocalEmbyRequest(
    new Request('http://local/emby/Branding/Css'),
    stripOptionalEmbyPrefix('/emby/Branding/Css'),
  )
  assert.equal(css?.status, 200)
  assert.equal(css?.headers.get('content-type'), 'text/css; charset=utf-8')
  assert.equal(await css!.text(), '')
})

test('narjo no lyrics capability probe is handled locally', async () => {
  const response = await dispatchEmbyRequest(
    new Request('http://local/emby-no-lyrics-api', {
      headers: { 'user-agent': 'Narjo/93' },
    }),
    stripOptionalEmbyPrefix('/emby-no-lyrics-api'),
  )

  assert.equal(response.status, 204)
  assert.equal(response.headers.get('x-x-music-source'), 'local')
})

test('emby dispatch adds cors headers for external players', async () => {
  const response = await dispatchEmbyRequest(new Request('http://local/System/Info/Public'), '/System/Info/Public')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*')
})

test('upstream proxy strips decoded-body compression headers', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999971')
    saveQQLoginCookie('uin=o999971; qm_keyst=test-key')
    markAccountUpstreamBound('999971')
    const account = getAccountByQQ('999971')
    assert.ok(account)
    globalThis.fetch = (async () => new Response(JSON.stringify({ Items: [] }), {
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'br',
        'content-length': '5',
      },
    })) as typeof fetch

    const response = await proxyToUpstreamEmby(localEmbyRequestForAccount(account, 'http://local/Items?Limit=1'), '/Items')

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/json')
    assert.equal(response.headers.get('content-encoding'), null)
    assert.equal(response.headers.get('content-length'), null)
    assert.deepEqual(await response.json(), { Items: [] })
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999971')
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('upstream proxy omits empty request body for body-capable methods', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999972')
    saveQQLoginCookie('uin=o999972; qm_keyst=test-key')
    markAccountUpstreamBound('999972')
    const account = getAccountByQQ('999972')
    assert.ok(account)
    let forwardedInit: RequestInit | undefined
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      forwardedInit = init
      return Response.json({ ok: true })
    }) as typeof fetch

    const response = await proxyToUpstreamEmby(localEmbyRequestForAccount(account, 'http://local/Sessions/Capabilities/Full', {
      method: 'POST',
    }), '/Sessions/Capabilities/Full')

    assert.equal(response.status, 200)
    assert.equal(forwardedInit?.method, 'POST')
    assert.equal(forwardedInit?.body, undefined)
    assert.equal((forwardedInit as RequestInit & { duplex?: string } | undefined)?.duplex, undefined)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999972')
    clearQQLoginCookie()
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
  updateEffectiveSettings({ qqEnabled: false, qqSyncPlaylists: false })
  const settings = getEffectiveSettings()
  assert.equal('emby' in settings, false)
  assert.equal(getEffectiveSettings().qq.enabled, false)
  assert.equal(getEffectiveSettings().qq.syncPlaylists, false)

  deleteSetting('qq.enabled')
  deleteSetting('qq.syncPlaylists')
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

test('local emby authenticate by name works without upstream Emby configuration', async () => {
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999901')
    saveQQLoginCookie('uin=o999901; qm_keyst=test-key')
    const account = getAccountByQQ('999901')
    assert.ok(account)

    const response = await handleLocalEmbyRequest(new Request('http://local/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), '/Users/AuthenticateByName')
    assert.equal(response?.status, 200)
    const payload = await response!.json()
    assert.equal(payload.User.Name, account.embyUsername)
    assert.equal(typeof payload.AccessToken, 'string')
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999901')
    clearQQLoginCookie()
  }
})

test('local emby dispatch returns local-only 404 without upstream Emby configuration', async () => {
  const response = await dispatchEmbyRequest(new Request('http://local/Unknown/Path'), '/Unknown/Path')
  assert.equal(response.status, 404)
  const payload = await response.json()
  assert.equal(payload.message, 'XMusic local Emby gateway did not handle this path, and no upstream Emby server is configured.')
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

test('narjo users current returns the authenticated local user', async () => {
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999117')
    saveQQLoginCookie('uin=o999117; qm_keyst=test-key')
    markAccountUpstreamBound('999117')
    const account = getAccountByQQ('999117')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()

    const response = await dispatchEmbyRequest(
      new Request(`http://local/Users/Current?api_key=${authPayload.AccessToken}`, {
        headers: { 'user-agent': 'Narjo/93' },
      }),
      stripOptionalEmbyPrefix('/Users/Current'),
    )
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.Id, authPayload.User.Id)
    assert.equal(payload.Name, account.embyUsername)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999117')
    clearQQLoginCookie()
  }
})

test('local emby authorized startup helpers are handled locally', async () => {
  const originalFetch = globalThis.fetch
  const upstreamRequests: string[] = []
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999116')
    saveQQLoginCookie('uin=o999116; qm_keyst=test-key')
    const account = getAccountByQQ('999116')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const headers = { 'X-Emby-Token': authPayload.AccessToken }

    globalThis.fetch = (async (url: string | URL | Request) => {
      upstreamRequests.push(String(url))
      return Response.json({ error: 'unexpected upstream request' }, { status: 500 })
    }) as typeof fetch

    const capabilities = await dispatchEmbyRequest(
      new Request('http://local/emby/Sessions/Capabilities/Full', { method: 'POST', headers }),
      stripOptionalEmbyPrefix('/emby/Sessions/Capabilities/Full'),
    )
    assert.equal(capabilities.status, 204)

    const sessions = await dispatchEmbyRequest(
      new Request('http://local/emby/Sessions', { headers }),
      stripOptionalEmbyPrefix('/emby/Sessions'),
    )
    assert.equal(sessions.status, 200)
    assert.deepEqual(await sessions.json(), [])

    const preferences = await dispatchEmbyRequest(
      new Request(`http://local/emby/DisplayPreferences/${authPayload.User.Id}?Client=Narjo`, { headers }),
      stripOptionalEmbyPrefix(`/emby/DisplayPreferences/${authPayload.User.Id}`),
    )
    assert.equal(preferences.status, 200)
    const preferencesPayload = await preferences.json()
    assert.equal(preferencesPayload.Id, authPayload.User.Id)
    assert.equal(preferencesPayload.Client, 'Narjo')

    const mediaFolders = await dispatchEmbyRequest(
      new Request('http://local/emby/Library/MediaFolders', { headers }),
      stripOptionalEmbyPrefix('/emby/Library/MediaFolders'),
    )
    assert.equal(mediaFolders.status, 200)
    assert.equal((await mediaFolders.json()).Items[0].Id, 'x-music-music')

    const counts = await dispatchEmbyRequest(
      new Request(`http://local/emby/Items/Counts?UserId=${authPayload.User.Id}`, { headers }),
      stripOptionalEmbyPrefix('/emby/Items/Counts'),
    )
    assert.equal(counts.status, 200)
    assert.equal((await counts.json()).SongCount, 0)
    assert.deepEqual(upstreamRequests, [])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999116')
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('configured upstream emby handles startup helper routes', async () => {
  const originalFetch = globalThis.fetch
  const upstreamRequests: string[] = []
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999115')
    saveQQLoginCookie('uin=o999115; qm_keyst=test-key')
    markAccountUpstreamBound('999115')
    const account = getAccountByQQ('999115')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const headers = { 'X-Emby-Token': authPayload.AccessToken }

    globalThis.fetch = (async (url: string | URL | Request) => {
      upstreamRequests.push(String(url))
      return Response.json({ upstream: true })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request('http://local/emby/Library/MediaFolders', { headers }),
      stripOptionalEmbyPrefix('/emby/Library/MediaFolders'),
    )
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { upstream: true })
    assert.equal(new URL(upstreamRequests[0]!).pathname, '/Library/MediaFolders')
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999115')
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('local emby authorized requests fail when QQ auth is expired', async () => {
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999904')
    saveQQLoginCookie('uin=o999904; qm_keyst=test-key')
    const account = getAccountByQQ('999904')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()

    db.prepare(`
      UPDATE accounts
      SET qq_auth_state = 'expired',
          qq_auth_error = 'expired test'
      WHERE qq_uin = ?
    `).run('999904')

    const response = await handleLocalEmbyRequest(new Request('http://local/emby/Users/Current', {
      headers: { 'X-Emby-Token': authPayload.AccessToken },
    }), stripOptionalEmbyPrefix('/emby/Users/Current'))
    assert.equal(response?.status, 428)
    const payload = await response!.json()
    assert.equal(payload.code, 'QQ_AUTH_REQUIRED')
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999904')
    clearQQLoginCookie()
  }
})

test('upstream fallback emby requests fail with QQ precondition when auth is expired', async () => {
  const originalFetch = globalThis.fetch
  let upstreamRequests = 0
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999906')
    saveQQLoginCookie('uin=o999906; qm_keyst=test-key')
    markAccountUpstreamBound('999906')
    const account = getAccountByQQ('999906')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()

    db.prepare(`
      UPDATE accounts
      SET qq_auth_state = 'expired',
          qq_auth_error = 'expired fallback proxy test'
      WHERE qq_uin = ?
    `).run('999906')
    globalThis.fetch = (async () => {
      upstreamRequests += 1
      return Response.json({ ok: true })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(new Request('http://local/emby/System/Info', {
      headers: { 'X-Emby-Token': authPayload.AccessToken },
    }), stripOptionalEmbyPrefix('/emby/System/Info'))
    assert.equal(response.status, 428)
    const payload = await response.json()
    assert.equal(payload.code, 'QQ_AUTH_REQUIRED')
    assert.match(payload.actionable, /QQ 授权/)
    assert.equal(upstreamRequests, 0)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999906')
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
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

test('account upstream emby config is stored per user and independent from env', () => {
  const previousBaseUrl = process.env.EMBY_UPSTREAM_URL
  const previousWebdav = process.env.EMBY_SOURCE_WEBDAV_DSN
  try {
    process.env.EMBY_UPSTREAM_URL = 'http://env-emby.example'
    process.env.EMBY_SOURCE_WEBDAV_DSN = 'https://env-user:env-pass@webdav.example/dav'
    db.prepare('DELETE FROM accounts WHERE qq_uin IN (?, ?)').run('999027', '999028')
    saveQQLoginCookie('uin=o999027; qm_keyst=test-key')
    saveQQLoginCookie('uin=o999028; qm_keyst=test-key')

    const first = updateAccountEmbyConfig('999027', {
      password: ' player-password ',
      dsn: ' https://admin:secret@emby-dsn.example:8096/ ',
      sourceWebdavDsn: ' https://dav-user:pass@webdav-user.example/dav/music/ ',
      proxyTimeoutMs: 45678.9,
    })
    assert.ok(first)
    assert.equal(first.embyPassword, 'player-password')
    assert.equal(first.embyDsn, 'https://admin:secret@emby-dsn.example:8096')
    assert.equal(first.embySourceWebdavDsn, 'https://dav-user:pass@webdav-user.example/dav/music')
    assert.equal(first.embyProxyTimeoutMs, 45678)
    assert.equal(hasAccountUpstreamEmby(first), true)
    assert.deepEqual(embyConfigForAccount(first), {
      dsn: 'https://admin:secret@emby-dsn.example:8096',
      baseUrl: 'https://emby-dsn.example:8096',
      username: 'admin',
      password: 'secret',
      sourceWebdavDsn: 'https://dav-user:pass@webdav-user.example/dav/music',
      proxyTimeoutMs: 45678,
    })

    const second = getAccountByQQ('999028')
    assert.ok(second)
    assert.equal(second.embyDsn, undefined)
    assert.equal(second.embySourceWebdavDsn, undefined)
    assert.equal(hasAccountUpstreamEmby(second), false)
    assert.deepEqual(embyConfigForAccount(second), {
      dsn: undefined,
      baseUrl: undefined,
      username: undefined,
      password: undefined,
      sourceWebdavDsn: undefined,
      proxyTimeoutMs: 30000,
    })
  } finally {
    if (previousBaseUrl === undefined) delete process.env.EMBY_UPSTREAM_URL
    else process.env.EMBY_UPSTREAM_URL = previousBaseUrl
    if (previousWebdav === undefined) delete process.env.EMBY_SOURCE_WEBDAV_DSN
    else process.env.EMBY_SOURCE_WEBDAV_DSN = previousWebdav
    db.prepare('DELETE FROM accounts WHERE qq_uin IN (?, ?)').run('999027', '999028')
    clearQQLoginCookie()
  }
})

test('account upstream emby config preserves masked dsn and supports clearing fields', () => {
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999029')
    saveQQLoginCookie('uin=o999029; qm_keyst=test-key')

    const saved = updateAccountEmbyConfig('999029', {
      password: 'player-password',
      dsn: 'https://admin:secret@emby.example',
      sourceWebdavDsn: 'https://user:pass@webdav.example/dav/music',
      proxyTimeoutMs: 45000,
    })
    assert.ok(saved)

    const preserved = updateAccountEmbyConfig('999029', {
      password: 'next-password',
      dsn: 'https://admin:********@emby.example',
    })
    assert.equal(preserved?.embyPassword, 'next-password')
    assert.equal(preserved?.embyDsn, 'https://admin:secret@emby.example')
    assert.equal(preserved?.embySourceWebdavDsn, 'https://user:pass@webdav.example/dav/music')
    assert.equal(preserved?.embyProxyTimeoutMs, 45000)

    const cleared = updateAccountEmbyConfig('999029', {
      password: 'next-password',
      dsn: '',
      sourceWebdavDsn: '',
      proxyTimeoutMs: null,
    })
    assert.equal(cleared?.embyDsn, undefined)
    assert.equal(cleared?.embySourceWebdavDsn, undefined)
    assert.equal(cleared?.embyProxyTimeoutMs, undefined)
    assert.equal(hasAccountUpstreamEmby(cleared), false)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999029')
    clearQQLoginCookie()
  }
})

test('local emby authenticate ignores upstream binding failures', async () => {
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
    assert.equal(response?.status, 200)
    const payload = await response!.json()
    assert.equal(payload.User.Name, account.embyUsername)
    assert.equal(typeof payload.AccessToken, 'string')
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
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
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
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
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
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
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

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
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
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
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
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
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

test('musiver items delete syncs mapped virtual playlist deletion upstream', async () => {
  const originalFetch = globalThis.fetch
  const playlistId = 'virtual-delete-mapped-playlist'
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999030')
    db.prepare("DELETE FROM remote_mappings WHERE local_type = 'playlist' AND local_key = ? AND remote = 'emby'").run(`qq:${playlistId}`)
    saveQQLoginCookie('uin=o999030; qm_keyst=test-key')
    markAccountUpstreamBound('999030')
    const account = getAccountByQQ('999030')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="Musiver", Version="1.3.9", Token="${authPayload.AccessToken}"`
    const virtualId = encodeVirtualId({ kind: 'qq-playlist', id: playlistId })

    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.playlist.${playlistId}`, JSON.stringify({
      source: 'tx',
      id: playlistId,
      name: 'Virtual Delete Mapped Playlist',
    }))
    upsertRemoteMapping({
      localType: 'playlist',
      localKey: `qq:${playlistId}`,
      remote: 'emby',
      remoteId: 'emby-delete-mapped-playlist',
    })

    const upstreamDeletes: Array<{ pathname: string; ids: string | null }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.pathname === '/Items/Delete' && init?.method === 'POST') {
        upstreamDeletes.push({ pathname: requestUrl.pathname, ids: requestUrl.searchParams.get('Ids') })
        return new Response(null, { status: 204 })
      }
      return Response.json({ error: 'unexpected upstream request' }, { status: 500 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Items/Delete?Ids=${encodeURIComponent(virtualId)}`, {
        method: 'POST',
        headers: { authorization: authHeader },
      }),
      stripOptionalEmbyPrefix('/emby/Items/Delete'),
    )
    assert.equal(response.status, 204)
    assert.deepEqual(upstreamDeletes, [
      { pathname: '/Items/Delete', ids: 'emby-delete-mapped-playlist' },
    ])
    const row = db.prepare("SELECT id FROM remote_mappings WHERE local_type = 'playlist' AND local_key = ? AND remote = 'emby'").get(`qq:${playlistId}`)
    assert.equal(row, undefined)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999030')
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(`virtual.playlist.${playlistId}`)
    db.prepare("DELETE FROM remote_mappings WHERE local_type = 'playlist' AND local_key = ? AND remote = 'emby'").run(`qq:${playlistId}`)
    clearQQLoginCookie()
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

test('virtual playlist item add maps virtual ids before syncing upstream Emby playlist', async () => {
  const originalFetch = globalThis.fetch
  const playlistId = 'virtual-playlist-add-map'
  const songmid = `virtual-playlist-add-map-${Date.now()}`
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999037')
    db.prepare("DELETE FROM remote_mappings WHERE local_type IN ('playlist', 'track') AND remote = 'emby'").run()
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
    const authHeader = `MediaBrowser Client="Musiver", Version="1.3.9", Token="${authPayload.AccessToken}"`

    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.playlist.${playlistId}`, JSON.stringify({
      source: 'tx',
      id: playlistId,
      name: 'Virtual Playlist Add Map',
    }))
    upsertRemoteMapping({
      localType: 'playlist',
      localKey: `qq:${playlistId}`,
      remote: 'emby',
      remoteId: 'emby-playlist-add-map',
    })
    upsertRemoteMapping({
      localType: 'track',
      localKey: `tx:${songmid}`,
      remote: 'emby',
      remoteId: 'emby-track-add-map',
    })

    const upstreamRequests: Array<{ pathname: string; ids: string | null }> = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      upstreamRequests.push({ pathname: requestUrl.pathname, ids: requestUrl.searchParams.get('Ids') })
      return new Response(null, { status: 204 })
    }) as typeof fetch

    const virtualPlaylistId = encodeVirtualId({ kind: 'qq-playlist', id: playlistId })
    const virtualSongId = encodeVirtualId({ kind: 'qq-song', songmid })
    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Playlists/${encodeURIComponent(virtualPlaylistId)}/Items?Ids=${encodeURIComponent(virtualSongId)}`, {
        method: 'POST',
        headers: { authorization: authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Playlists/${encodeURIComponent(virtualPlaylistId)}/Items`),
    )
    assert.equal(response.status, 204)
    assert.deepEqual(upstreamRequests, [
      { pathname: '/Playlists/emby-playlist-add-map/Items', ids: 'emby-track-add-map' },
    ])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999037')
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(`virtual.playlist.${playlistId}`)
    db.prepare("DELETE FROM remote_mappings WHERE local_type IN ('playlist', 'track') AND remote = 'emby'").run()
    clearQQLoginCookie()
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

test('first favorite write for an upstream Emby QQ song creates a mapping and syncs QQ', async () => {
  const originalFetch = globalThis.fetch
  const songmid = 'first-upstream-favorite-song'
  const itemId = 'emby-first-favorite-song'
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999047')
    saveQQLoginCookie('uin=o999047; euin=encrypted999047; qm_keyst=test-key')
    markAccountUpstreamBound('999047', 'emby-user-999047', 'emby-user-token-999047')
    const account = getAccountByQQ('999047')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()

    let qqDetailRequests = 0
    let qqFavoriteRequests = 0
    const upstreamFavoriteWrites: Array<{ pathname: string; method: string }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
        if (body.songinfo) {
          qqDetailRequests += 1
          return Response.json({
            code: 0,
            songinfo: {
              code: 0,
              data: {
                track_info: {
                  mid: songmid,
                  id: 771122,
                  type: 0,
                  name: 'First Upstream Favorite Song',
                  singer: [{ name: 'Favorite Artist' }],
                  album: { mid: 'album-mid', name: 'Favorite Album' },
                  interval: 180,
                  file: {},
                },
              },
            },
          })
        }
        qqFavoriteRequests += 1
        return Response.json({ code: 0, req: { code: 0, data: { retCode: 0 } } })
      }
      if (requestUrl.pathname.endsWith(`/Items/${itemId}`)) {
        return Response.json({
          Id: itemId,
          Name: 'First Upstream Favorite Song',
          Album: 'Favorite Album',
          Artists: ['Favorite Artist'],
          ProviderIds: { QQMusic: songmid },
        })
      }
      if (requestUrl.pathname.endsWith(`/Users/emby-user-999047/FavoriteItems/${itemId}`)) {
        upstreamFavoriteWrites.push({ pathname: requestUrl.pathname, method: init?.method ?? 'GET' })
        return Response.json({ IsFavorite: true, ItemId: itemId })
      }
      return Response.json({ error: 'unexpected upstream request' }, { status: 500 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/Users/${authPayload.User.Id}/FavoriteItems/${itemId}`, {
        method: 'POST',
        headers: { 'X-Emby-Token': authPayload.AccessToken },
      }),
      `/Users/${authPayload.User.Id}/FavoriteItems/${itemId}`,
    )

    assert.equal(response.status, 200)
    assert.equal(qqDetailRequests, 1)
    assert.equal(qqFavoriteRequests, 1)
    assert.deepEqual(upstreamFavoriteWrites, [{
      pathname: `/Users/emby-user-999047/FavoriteItems/${itemId}`,
      method: 'POST',
    }])
    assert.equal(getFavoriteStatus('tx', songmid).favorite, true)
    assert.equal(getFavoriteStatus('tx', songmid).syncState, 'synced')
    const mapping = db.prepare(`
      SELECT user_id AS userId, local_key AS localKey
      FROM remote_mappings
      WHERE remote = 'emby' AND remote_id = ?
    `).get(itemId) as { userId?: string; localKey?: string } | undefined
    assert.equal(mapping?.userId, account.userId)
    assert.equal(mapping?.localKey, `tx:${songmid}`)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999047')
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('favorite write for a non-QQ upstream item falls back to Emby', async () => {
  const originalFetch = globalThis.fetch
  const itemId = 'emby-non-qq-favorite-song'
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999048')
    saveQQLoginCookie('uin=o999048; euin=encrypted999048; qm_keyst=test-key')
    markAccountUpstreamBound('999048', 'emby-user-999048', 'emby-user-token-999048')
    const account = getAccountByQQ('999048')
    assert.ok(account)
    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()

    const upstreamRequests: Array<{ pathname: string; method: string }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      upstreamRequests.push({ pathname: requestUrl.pathname, method: init?.method ?? 'GET' })
      if (requestUrl.pathname.endsWith(`/Items/${itemId}`)) {
        return Response.json({ Id: itemId, Name: 'Local Emby Song', Artists: ['Local Artist'] })
      }
      if (requestUrl.pathname.endsWith(`/Users/emby-user-999048/FavoriteItems/${itemId}`)) {
        return new Response(null, { status: 204 })
      }
      return Response.json({ error: 'unexpected upstream request' }, { status: 500 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/Users/${authPayload.User.Id}/FavoriteItems/${itemId}`, {
        method: 'POST',
        headers: { 'X-Emby-Token': authPayload.AccessToken },
      }),
      `/Users/${authPayload.User.Id}/FavoriteItems/${itemId}`,
    )

    assert.equal(response.status, 204)
    assert.deepEqual(upstreamRequests.map(item => item.method), ['GET', 'POST'])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999048')
    clearQQLoginCookie()
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

test('local emby favorite list uses mapped upstream item ids for synced QQ songs', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `qq-favorite-mapped-${Date.now()}`
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999050')
    saveQQLoginCookie('uin=o999050; euin=encrypted999050; qm_keyst=test-key')
    markAccountUpstreamBound('999050')
    const account = getAccountByQQ('999050')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`

    const mappedSong: MusicInfo = {
      source: 'tx',
      songmid,
      name: 'Mapped Favorite Song',
      singer: 'QQ Artist',
      albumName: 'Mapped Favorite Album',
      albumId: 'qq-album-1',
      interval: '03:08',
      img: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000qq-album-1.jpg',
      types: [{ type: 'flac', size: '10 MB' }],
      raw: { songId: 449205, songmid },
    }
    upsertRemoteMapping({
      localType: 'track',
      localKey: `tx:${songmid}`,
      remote: 'emby',
      remoteId: 'emby-mapped-favorite-item',
      raw: mappedSong,
    })

    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              songlist: [{
                id: 449205,
                mid: songmid,
                title: mappedSong.name,
                interval: 188,
                singer: [{ name: mappedSong.singer, mid: 'qq-artist-1' }],
                album: { name: mappedSong.albumName, mid: mappedSong.albumId },
                file: { media_mid: songmid, size_flac: 10 * 1024 * 1024 },
              }],
              total_song_num: 1,
            },
          },
        })
      }

      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=x-music-music&Filters=IsFavorite&Limit=100&StartIndex=0`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.Items[0].Id, 'emby-mapped-favorite-item')
    assert.equal(payload.Items[0].MediaSources[0].Id, 'emby-mapped-favorite-item')
    assert.equal(payload.Items[0].MediaSources[0].Path, '/Audio/emby-mapped-favorite-item/universal')
    assert.equal(payload.Items[0].HasLyrics, true)
    assert.equal(payload.Items[0].MediaSources[0].MediaStreams[1].Type, 'Subtitle')
    assert.equal(payload.Items[0].MediaSources[0].MediaStreams[1].DeliveryUrl, '/Items/emby-mapped-favorite-item/Subtitles/1/Stream.js')
    assert.equal(payload.Items[0].MediaSources[0].DefaultSubtitleStreamIndex, 1)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999050')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM remote_mappings WHERE local_type = 'track' AND local_key = ? AND remote = 'emby'").run(`tx:${songmid}`)
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

test('musiver favorite list keeps selected virtual song ids stable across detail and playback', async () => {
  const originalFetch = globalThis.fetch
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
    const authHeader = `MediaBrowser Client="Musiver", Device="Mi-Mini-M2", Version="1.3.9", Token="${authPayload.AccessToken}"`

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
        const begin = Number(body.req?.param?.song_begin ?? 0)
        const count = Number(body.req?.param?.song_num ?? 0)
        const songs = [
          {
            id: 1,
            mid: 'qq-musiver-before-target',
            title: 'Before Target Song',
            interval: 188,
            singer: [{ name: 'Before Artist', mid: 'qq-artist-before' }],
            album: { name: 'Before Album', mid: 'qq-album-before' },
            fav_time: '2024-01-02T00:00:00.000Z',
            file: { media_mid: 'qq-media-before', size_320mp3: 1024 },
          },
          {
            id: 2,
            mid: '004a6D4b14LK4E',
            title: '萬千花蕊慈母悲哀',
            interval: 188,
            singer: [{ name: '珂拉琪 Collage', mid: 'qq-artist-collage' }],
            album: { name: 'MEmento MORI', mid: 'qq-album-collage' },
            fav_time: '2024-01-01T00:00:00.000Z',
            file: { media_mid: '004a6D4b14LK4E', size_flac: 49_863_855 },
          },
        ].slice(begin, begin + count)
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              songlist: songs,
              total_song_num: 2,
            },
          },
        })
      }

      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const list = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&Recursive=true&Fields=AudioInfo%2CSortName%2CMediaSources%2CDateCreated%2CProductionYear%2CCanDelete&StartIndex=0&Limit=30&ImageTypeLimit=1&EnableImageTypes=Primary&SortBy=SortName&SortOrder=Descending&isFavorite=true&ParentId=x-music-music`, {
        headers: { authorization: authHeader, 'user-agent': 'musiver/1.3.9 (Macintosh)' },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(list.status, 200)
    const listPayload = await list.json()
    assert.deepEqual(listPayload.Items.map((item: { Name: string }) => item.Name), [
      'Before Target Song',
      '萬千花蕊慈母悲哀',
    ])
    const target = listPayload.Items[1]
    const targetId = encodeVirtualId({ kind: 'qq-song', songmid: '004a6D4b14LK4E' })
    assert.equal(target.Id, targetId)
    assert.equal(target.MediaSources[0].Id, targetId)
    assert.equal(target.MediaSources[0].ItemId, targetId)
    assert.equal(target.MediaSources[0].Path, `/Audio/${encodeURIComponent(targetId)}/universal`)
    assert.equal(target.ImageTags.Primary, targetId)
    assert.equal(target.AlbumPrimaryImageTag, targetId)
    assert.equal(target.HasLyrics, true)

    const detail = await dispatchEmbyRequest(
      new Request(`http://local/Users/${authPayload.User.Id}/Items/${encodeURIComponent(targetId)}`, {
        headers: { authorization: authHeader, 'user-agent': 'musiver/1.3.9 (Macintosh)' },
      }),
      stripOptionalEmbyPrefix(`/Users/${authPayload.User.Id}/Items/${encodeURIComponent(targetId)}`),
    )
    assert.equal(detail.status, 200)
    const detailPayload = await detail.json()
    assert.equal(detailPayload.Id, targetId)
    assert.equal(detailPayload.Name, '萬千花蕊慈母悲哀')
    assert.equal(detailPayload.MediaSources[0].Path, target.MediaSources[0].Path)

    const playbackInfo = await dispatchEmbyRequest(
      new Request(`http://local/Items/${encodeURIComponent(targetId)}/PlaybackInfo`, {
        headers: { authorization: authHeader, 'user-agent': 'musiver/1.3.9 (Macintosh)' },
      }),
      stripOptionalEmbyPrefix(`/Items/${encodeURIComponent(targetId)}/PlaybackInfo`),
    )
    assert.equal(playbackInfo.status, 200)
    const playbackPayload = await playbackInfo.json()
    assert.equal(playbackPayload.MediaSources[0].Id, targetId)
    assert.equal(playbackPayload.MediaSources[0].ItemId, targetId)
    assert.equal(playbackPayload.MediaSources[0].Path, target.MediaSources[0].Path)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999043')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key LIKE 'virtual.song.qq-musiver-before-target'").run()
    db.prepare("DELETE FROM app_settings WHERE key = 'virtual.song.004a6D4b14LK4E'").run()
    globalThis.fetch = originalFetch
  }
})

test('virtual song items omit invalid album ids while keeping primary image tag', async () => {
  const songmid = 'qq-null-album-song'
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999118')
    saveQQLoginCookie('uin=o999118; qm_keyst=test-key')
    markAccountUpstreamBound('999118')
    const account = getAccountByQQ('999118')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()

    const virtualId = encodeVirtualId({ kind: 'qq-song', songmid })
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({
      song: {
        source: 'tx',
        songmid,
        name: 'Null Album Song',
        singer: 'QQ Artist',
        albumName: 'QQ Album',
        albumId: 'null',
        img: 'https://img.example/null-album.jpg',
        interval: '03:00',
        types: [],
      },
    }))

    const detail = await dispatchEmbyRequest(
      new Request(`http://local/Items/${encodeURIComponent(virtualId)}`, {
        headers: { 'X-Emby-Authorization': `MediaBrowser Client="musiver", Version="1.3.9", Device="Macintosh", Token="${authPayload.AccessToken}"` },
      }),
      stripOptionalEmbyPrefix(`/Items/${encodeURIComponent(virtualId)}`),
    )

    assert.equal(detail.status, 200)
    const payload = await detail.json()
    assert.equal(payload.Id, virtualId)
    assert.equal(payload.AlbumId, undefined)
    assert.equal(payload.ImageTags.Primary, virtualId)
    assert.equal(payload.AlbumPrimaryImageTag, virtualId)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999118')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
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

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as any : undefined
      if (requestUrl.hostname === 'u.y.qq.com' && body?.req?.module === 'music.recommend.RecommendFeed') {
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              v_shelf: [{ v_niche: [{ v_card: [{ id: '123456789', title: '每日30首' }] }] }],
            },
          },
        })
      }

      if (requestUrl.hostname === 'u.y.qq.com' && body?.req?.module === 'music.srfDissInfo.DissInfo') {
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              songlist: [{
                id: 123,
                mid: 'qq-daily-song-1',
                title: 'QQ Daily Song',
                interval: 188,
                singer: [{ name: 'QQ Artist', mid: 'qq-artist-1' }],
                album: { name: 'QQ Album', mid: 'qq-album-1' },
                file: { media_mid: 'qq-media-1', size_320mp3: 1024 },
              }],
            },
          },
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

test('local emby recommendation playlists cap each page and reuse the per-user pool', async () => {
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
    let recommendationRequestCode = 0
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
        if (body.req?.module === 'music.getSession.session') return qqRadioSessionResponse()
        if (body.req?.module === 'music.radioProxy.MbTrackRadioSvr') {
          const pageSize = Number(body.req.param.num ?? 0)
          recommendationLimits.push(pageSize)
          return Response.json({
            code: 0,
            req: {
              code: recommendationRequestCode,
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

    const firstPage = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio%2CMusicVideo&ParentId=${encodeURIComponent(guessId)}&Limit=5&StartIndex=0`, {
        headers: {
          'X-Emby-Authorization': `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`,
        },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(firstPage.status, 200)
    const firstPagePayload = await firstPage.json()
    assert.equal(firstPagePayload.Items.length, 5)
    assert.equal(firstPagePayload.TotalRecordCount, 999)
    assert.deepEqual(recommendationLimits, [5])

    recommendationRequestCode = 2000
    const cachedFallback = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio%2CMusicVideo&ParentId=${encodeURIComponent(guessId)}&Limit=250&StartIndex=0`, {
        headers: {
          'X-Emby-Authorization': `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`,
        },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(cachedFallback.status, 200)
    assert.equal((await cachedFallback.json()).Items.length, 5)

    recommendationRequestCode = 0
    const expandedFirstPage = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio%2CMusicVideo&ParentId=${encodeURIComponent(guessId)}&Limit=250&StartIndex=0`, {
        headers: {
          'X-Emby-Authorization': `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`,
        },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )

    assert.equal(expandedFirstPage.status, 200)
    const expandedFirstPagePayload = await expandedFirstPage.json()
    assert.equal(expandedFirstPagePayload.Items.length, 20)
    assert.equal(expandedFirstPagePayload.TotalRecordCount, 999)
    assert.equal(recommendationLimits.length, 5)
    assert.ok(recommendationLimits.every(limit => limit === 5))

    const secondPageRequest = () => dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio%2CMusicVideo&ParentId=${encodeURIComponent(guessId)}&Limit=20&StartIndex=20`, {
        headers: {
          'X-Emby-Authorization': `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`,
        },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    const secondPage = await secondPageRequest()
    assert.equal(secondPage.status, 200)
    const secondPagePayload = await secondPage.json()
    assert.equal(secondPagePayload.Items.length, 20)
    assert.equal(secondPagePayload.TotalRecordCount, 999)
    assert.equal(recommendationLimits.length, 9)

    const repeatedSecondPage = await secondPageRequest()
    assert.equal(repeatedSecondPage.status, 200)
    assert.equal((await repeatedSecondPage.json()).Items.length, 20)
    assert.equal(recommendationLimits.length, 9)

    const jumpedPage = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio%2CMusicVideo&ParentId=${encodeURIComponent(guessId)}&Limit=1000&StartIndex=300`, {
        headers: {
          'X-Emby-Authorization': `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`,
        },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(jumpedPage.status, 200)
    assert.equal((await jumpedPage.json()).Items.length, 20)
    assert.equal(recommendationLimits.length, 13)

    const pageBeyondInitialHint = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio%2CMusicVideo&ParentId=${encodeURIComponent(guessId)}&Limit=30&StartIndex=990`, {
        headers: {
          'X-Emby-Authorization': `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`,
        },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(pageBeyondInitialHint.status, 200)
    const pageBeyondInitialHintPayload = await pageBeyondInitialHint.json()
    assert.equal(pageBeyondInitialHintPayload.Items.length, 20)
    assert.equal(pageBeyondInitialHintPayload.TotalRecordCount, 1030)
    assert.equal(recommendationLimits.length, 17)

    recommendationRequestCode = 1000
    const unavailableRecommendationAuthorization = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio%2CMusicVideo&ParentId=${encodeURIComponent(guessId)}&Limit=20&StartIndex=600`, {
        headers: {
          'X-Emby-Authorization': `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`,
        },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(unavailableRecommendationAuthorization.status, 428)
    assert.equal((await unavailableRecommendationAuthorization.json()).code, 'QQ_RECOMMENDATION_AUTH_REQUIRED')
    assert.equal(getAccountByQQ('999018')?.qqAuthState, 'active')
    assert.equal(recommendationLimits.length, 19)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999018')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key LIKE 'virtual.song.qq-rec-song-%'").run()
    globalThis.fetch = originalFetch
  }
})

test('local emby recommendation playlists filter recently unavailable songs', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999122')
    saveQQLoginCookie('uin=o999122; qm_keyst=test-key')
    markAccountUpstreamBound('999122')
    const account = getAccountByQQ('999122')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const guessId = encodeVirtualId({ kind: 'qq-guess' })

    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run('music-url.unplayable.tx.qq-rec-unavailable', JSON.stringify({
      source: 'tx',
      songmid: 'qq-rec-unavailable',
      reason: 'ERR无版权',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }))

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
        if (body.req?.module === 'music.getSession.session') return qqRadioSessionResponse()
        if (body.req?.module === 'music.radioProxy.MbTrackRadioSvr') {
          return Response.json({
            code: 0,
            req: {
              code: 0,
              data: {
                Tracks: [
                  {
                    id: 1,
                    mid: 'qq-rec-unavailable',
                    title: 'Unavailable Rec',
                    interval: 188,
                    singer: [{ name: 'QQ Artist', mid: 'qq-artist-1' }],
                    album: { name: 'QQ Album', mid: 'qq-album-1' },
                    file: { media_mid: 'qq-media-1', size_320mp3: 1024 },
                  },
                  {
                    id: 2,
                    mid: 'qq-rec-playable',
                    title: 'Playable Rec',
                    interval: 188,
                    singer: [{ name: 'QQ Artist', mid: 'qq-artist-1' }],
                    album: { name: 'QQ Album', mid: 'qq-album-1' },
                    file: { media_mid: 'qq-media-2', size_320mp3: 1024 },
                  },
                ],
              },
            },
          })
        }
      }

      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=${encodeURIComponent(guessId)}&Limit=10&StartIndex=0`, {
        headers: {
          'X-Emby-Authorization': `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`,
        },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.deepEqual(payload.Items.map((item: any) => item.Name), ['Playable Rec'])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999122')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key IN ('music-url.unplayable.tx.qq-rec-unavailable', 'virtual.song.qq-rec-playable')").run()
    db.prepare("DELETE FROM app_settings WHERE key = 'virtual.song.qq-rec-unavailable'").run()
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
    db.prepare('INSERT INTO play_events (user_id, track_id, quality, played_at) VALUES (?, ?, ?, ?)').run(account.userId, track.id, '320k', '2026-05-21T10:00:00.000Z')
    db.prepare('INSERT INTO play_events (user_id, track_id, quality, played_at) VALUES (?, ?, ?, ?)').run(account.userId, track.id, '320k', '2026-05-22T10:00:00.000Z')

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
      if (requestUrl.hostname === 'u.y.qq.com') {
        return Response.json({
          code: 0,
          lyric: {
            code: 0,
            data: {
              lyric: '[00:01.23]第一句\n[00:04.00]第二句',
            },
          },
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

    const audioLyrics = await dispatchEmbyRequest(
      new Request(`http://local/Audio/${encodeURIComponent(songId)}/Lyrics`, {
        headers: { authorization: authHeader, 'user-agent': 'Narjo/93' },
      }),
      stripOptionalEmbyPrefix(`/Audio/${encodeURIComponent(songId)}/Lyrics`),
    )
    assert.equal(audioLyrics.status, 200)
    const audioLyricsPayload = await audioLyrics.json()
    assert.deepEqual(audioLyricsPayload.Lyrics, payload.Lyrics)

    const playbackInfo = await dispatchEmbyRequest(
      new Request(`http://local/Items/${encodeURIComponent(songId)}/PlaybackInfo`, {
        headers: { authorization: authHeader },
      }),
      stripOptionalEmbyPrefix(`/Items/${encodeURIComponent(songId)}/PlaybackInfo`),
    )
    assert.equal(playbackInfo.status, 200)
    const playbackPayload = await playbackInfo.json()
    assert.equal(playbackPayload.MediaSources[0].MediaStreams[1].Type, 'Subtitle')
    assert.equal(playbackPayload.MediaSources[0].MediaStreams[1].Index, 1)
    assert.equal(playbackPayload.MediaSources[0].DefaultSubtitleStreamIndex, 1)
    assert.equal(playbackPayload.MediaSources[0].MediaStreams[1].DeliveryMethod, 'External')
    assert.match(playbackPayload.MediaSources[0].MediaStreams[1].DeliveryUrl, /Stream\.js$/)
    assert.match(playbackPayload.MediaSources[0].MediaStreams[1].DeliveryUrl, /\/Subtitles\/1\/Stream\.js$/)

    const declaredSubtitle = await dispatchEmbyRequest(
      new Request(`http://local${playbackPayload.MediaSources[0].MediaStreams[1].DeliveryUrl}?Token=${authPayload.AccessToken}`, {
        headers: { 'user-agent': 'musiver/1.3.9 (Macintosh)' },
      }),
      stripOptionalEmbyPrefix(playbackPayload.MediaSources[0].MediaStreams[1].DeliveryUrl),
    )
    assert.equal(declaredSubtitle.status, 200)
    assert.match(declaredSubtitle.headers.get('content-type') ?? '', /application\/json/)
    const declaredPayload = await declaredSubtitle.json()
    assert.equal(declaredPayload.TrackEvents[0].Text, '第一句')

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
      stripOptionalEmbyPrefix(`/Items/${encodeURIComponent(songId)}/${encodeURIComponent(songId)}/Subtitles/1/Stream.js?MediaBrowser%20Client=Musiver&Device=Mi-Mini-M2&Version=1.3.9&Token=${authPayload.AccessToken}`),
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

test('narjo subsonic lyric requests resolve mapped upstream item ids locally', async () => {
  const originalFetch = globalThis.fetch
  const songmid = 'qq-narjo-subsonic-lyrics'
  const remoteId = '11761871'
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999115')
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
    db.prepare("DELETE FROM remote_mappings WHERE local_type = 'track' AND local_key = ? AND remote = 'emby'").run(`tx:${songmid}`)
    saveQQLoginCookie('uin=o999115; qm_keyst=test-key')
    markAccountUpstreamBound('999115')
    const account = getAccountByQQ('999115')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="Narjo", Version="93", Device="iOS", Token="${authPayload.AccessToken}"`
    const song: MusicInfo = {
      source: 'tx',
      songmid,
      name: 'Narjo Subsonic Lyrics',
      singer: 'QQ Lyrics Artist',
      albumName: 'QQ Lyrics Album',
      interval: '03:08',
      types: [{ type: '320k', size: '1 MB' }],
      raw: { songId: 654321, strMediaMid: 'qq-media-narjo-lyrics' },
    }
    ensureTrack(song)
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({ song }))
    upsertRemoteMapping({
      localType: 'track',
      localKey: `tx:${songmid}`,
      remote: 'emby',
      remoteId,
      raw: song,
    })

    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        return Response.json({
          code: 0,
          lyric: {
            code: 0,
            data: {
              lyric: '[00:02.00]Narjo 第一行\n[00:05.50]Narjo 第二行',
            },
          },
        })
      }
      return Response.json({ error: 'should not proxy upstream' }, { status: 500 })
    }) as typeof fetch

    const lyrics = await dispatchEmbyRequest(
      new Request(`http://local/rest/getLyricsBySongId.view?id=${remoteId}&v=1.16.1&c=Narjo&f=json&u=${account.embyUsername}`, {
        headers: { 'X-Emby-Authorization': authHeader, 'user-agent': 'Narjo/93' },
      }),
      stripOptionalEmbyPrefix('/rest/getLyricsBySongId.view'),
    )
    assert.equal(lyrics.status, 200)
    assert.equal(lyrics.headers.get('x-x-music-source'), 'local')
    const lyricsPayload = await lyrics.json()
    const structured = lyricsPayload['subsonic-response'].lyricsList.structuredLyrics[0]
    assert.equal(structured.synced, true)
    assert.deepEqual(structured.line, [
      { start: 2000, value: 'Narjo 第一行' },
      { start: 5500, value: 'Narjo 第二行' },
    ])

    const getSong = await dispatchEmbyRequest(
      new Request(`http://local/rest/getSong.view?id=${remoteId}&v=1.16.1&c=Narjo&f=json&u=${account.embyUsername}`, {
        headers: { 'X-Emby-Authorization': authHeader, 'user-agent': 'Narjo/93' },
      }),
      stripOptionalEmbyPrefix('/rest/getSong.view'),
    )
    assert.equal(getSong.status, 200)
    assert.equal(getSong.headers.get('x-x-music-source'), 'local')
    const songPayload = await getSong.json()
    assert.equal(songPayload['subsonic-response'].song.title, 'Narjo Subsonic Lyrics')
    assert.match(songPayload['subsonic-response'].song.id, /^mix_/)

    const queryUserLyrics = await dispatchEmbyRequest(
      new Request(`http://local/rest/getLyricsBySongId.view?id=${encodeURIComponent(encodeVirtualId({ kind: 'qq-song', songmid }))}&v=1.16.1&c=Narjo&f=json&u=QQ999115`, {
        headers: { 'user-agent': 'Narjo/93' },
      }),
      stripOptionalEmbyPrefix('/rest/getLyricsBySongId.view'),
    )
    assert.equal(queryUserLyrics.status, 200)
    assert.equal(queryUserLyrics.headers.get('x-x-music-source'), 'local')

    const audioLyricsWithoutToken = await dispatchEmbyRequest(
      new Request(`http://local/Audio/${encodeURIComponent(encodeVirtualId({ kind: 'qq-song', songmid }))}/Lyrics?u=QQ999115`, {
        headers: { 'user-agent': 'Narjo/93' },
      }),
      stripOptionalEmbyPrefix(`/Audio/${encodeURIComponent(encodeVirtualId({ kind: 'qq-song', songmid }))}/Lyrics`),
    )
    assert.equal(audioLyricsWithoutToken.status, 200)
    assert.equal(audioLyricsWithoutToken.headers.get('x-x-music-source'), 'local')
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999115')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
    db.prepare("DELETE FROM remote_mappings WHERE local_type = 'track' AND local_key = ? AND remote = 'emby'").run(`tx:${songmid}`)
    globalThis.fetch = originalFetch
  }
})

test('musiver subtitle js stream returns empty track events when QQ lyrics are unavailable', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999044')
    saveQQLoginCookie('uin=o999044; qm_keyst=test-key')
    markAccountUpstreamBound('999044')
    const account = getAccountByQQ('999044')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const songId = encodeVirtualId({ kind: 'qq-song', songmid: 'qq-empty-lyrics-song' })

    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run('virtual.song.qq-empty-lyrics-song', JSON.stringify({
      song: {
        source: 'tx',
        songmid: 'qq-empty-lyrics-song',
        name: 'QQ Empty Lyrics Song',
        singer: 'QQ Lyrics Artist',
        albumName: 'QQ Lyrics Album',
        interval: '03:08',
        types: [{ type: '320k', size: '1 MB' }],
        raw: { strMediaMid: 'qq-media-empty-lyrics' },
      },
    }))

    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.pathname.includes('/lyric/fcgi-bin/fcg_query_lyric_new.fcg')) {
        return Response.json({})
      }
      return Response.json({ error: 'unexpected upstream request' }, { status: 500 })
    }) as typeof fetch

    const subtitle = await dispatchEmbyRequest(
      new Request(`http://local/Items/${encodeURIComponent(songId)}/${encodeURIComponent(songId)}/Subtitles/2/Stream.js?MediaBrowser%20Client=Musiver&Device=Mi-Mini-M2&Version=1.3.9&Token=${authPayload.AccessToken}`, {
        headers: { 'user-agent': 'musiver/1.3.9 (Macintosh)' },
      }),
      stripOptionalEmbyPrefix(`/Items/${encodeURIComponent(songId)}/${encodeURIComponent(songId)}/Subtitles/2/Stream.js?MediaBrowser%20Client=Musiver&Device=Mi-Mini-M2&Version=1.3.9&Token=${authPayload.AccessToken}`),
    )
    assert.equal(subtitle.status, 200)
    assert.match(subtitle.headers.get('content-type') ?? '', /application\/json/)
    assert.deepEqual(await subtitle.json(), { TrackEvents: [] })
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999044')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key = 'virtual.song.qq-empty-lyrics-song'").run()
    globalThis.fetch = originalFetch
  }
})

test('virtual song lyrics prefer cached sidecar lyrics before upstream sources', async () => {
  const originalFetch = globalThis.fetch
  const songmid = 'qq-sidecar-lyrics-song'
  const audioPath = join(process.cwd(), 'data/test-sidecar-lyrics-song.mp3')
  const lyricsPath = join(process.cwd(), 'data/test-sidecar-lyrics-song.lrc')
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999045')
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
    saveQQLoginCookie('uin=o999045; qm_keyst=test-key')
    markAccountUpstreamBound('999045')
    const account = getAccountByQQ('999045')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const songId = encodeVirtualId({ kind: 'qq-song', songmid })
    const song: MusicInfo = {
      source: 'tx',
      songmid,
      name: 'QQ Sidecar Lyrics Song',
      singer: 'QQ Lyrics Artist',
      albumName: 'QQ Lyrics Album',
      interval: '03:08',
      types: [{ type: '320k', size: '1 MB' }],
      raw: { strMediaMid: 'qq-media-sidecar-lyrics' },
    }

    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({ song }))

    mkdirSync(join(process.cwd(), 'data'), { recursive: true })
    writeFileSync(audioPath, 'audio-bytes')
    writeFileSync(lyricsPath, '[00:01.00]本地歌词')
    const track = ensureTrack(song)
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: audioPath, sizeBytes: 11, sha256: 'sidecarsha' })

    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.pathname.includes('/lyric/fcgi-bin/fcg_query_lyric_new.fcg')) {
        return Response.json({
          lyric: Buffer.from('[00:01.00]QQ歌词', 'utf8').toString('base64'),
        })
      }
      return Response.json({ error: 'unexpected upstream request' }, { status: 500 })
    }) as typeof fetch

    const subtitle = await dispatchEmbyRequest(
      new Request(`http://local/Items/${encodeURIComponent(songId)}/Subtitles/2/Stream.js?Token=${authPayload.AccessToken}`, {
        headers: { 'user-agent': 'musiver/1.3.9 (Macintosh)' },
      }),
      stripOptionalEmbyPrefix(`/Items/${encodeURIComponent(songId)}/Subtitles/2/Stream.js?Token=${authPayload.AccessToken}`),
    )
    assert.equal(subtitle.status, 200)
    const payload = await subtitle.json()
    assert.equal(payload.TrackEvents[0].Text, '本地歌词')
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999045')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
    rmSync(audioPath, { force: true })
    rmSync(lyricsPath, { force: true })
    globalThis.fetch = originalFetch
  }
})

test('virtual song lyrics persist QQ fallback to local sidecar for Emby sync', async () => {
  const originalFetch = globalThis.fetch
  const songmid = 'qq-persist-lyrics-song'
  const audioPath = join(appConfig.musicDir, 'QQ Lyrics Artist', 'QQ Lyrics Album', 'QQ Lyrics Artist - QQ Persist Lyrics Song.mp3')
  const lyricsPath = join(appConfig.musicDir, 'QQ Lyrics Artist', 'QQ Lyrics Album', 'QQ Lyrics Artist - QQ Persist Lyrics Song.lrc')
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999046')
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
    db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track' AND json_extract(payload_json, '$.songmid') = ?").run(songmid)
    saveQQLoginCookie('uin=o999046; qm_keyst=test-key')
    markAccountUpstreamBound('999046')
    const account = getAccountByQQ('999046')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const songId = encodeVirtualId({ kind: 'qq-song', songmid })
    const song: MusicInfo = {
      source: 'tx',
      songmid,
      name: 'QQ Persist Lyrics Song',
      singer: 'QQ Lyrics Artist',
      albumName: 'QQ Lyrics Album',
      interval: '03:08',
      types: [{ type: '320k', size: '1 MB' }],
      raw: { songId: 765432, strMediaMid: 'qq-media-persist-lyrics' },
    }

    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({ song }))

    mkdirSync(dirname(audioPath), { recursive: true })
    writeFileSync(audioPath, 'audio-bytes')
    const track = ensureTrack(song)
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: audioPath, sizeBytes: 11, sha256: 'persistsha' })
    requestUserTrackSync(account.userId, track.id, 'lyrics')

    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              lyric: '[00:01.00]QQ落盘歌词',
            },
          },
        })
      }
      return Response.json({ error: 'unexpected upstream request' }, { status: 500 })
    }) as typeof fetch

    const subtitle = await dispatchEmbyRequest(
      new Request(`http://local/Items/${encodeURIComponent(songId)}/Subtitles/2/Stream.js?Token=${authPayload.AccessToken}`, {
        headers: { 'user-agent': 'musiver/1.3.9 (Macintosh)' },
      }),
      stripOptionalEmbyPrefix(`/Items/${encodeURIComponent(songId)}/Subtitles/2/Stream.js?Token=${authPayload.AccessToken}`),
    )
    assert.equal(subtitle.status, 200)
    const payload = await subtitle.json()
    assert.equal(payload.TrackEvents[0].Text, 'QQ落盘歌词')
    assert.match(readFileSync(lyricsPath, 'utf8'), /QQ落盘歌词/)
    const row = db.prepare(`
      SELECT tf.lyrics_path AS lyricsPath
      FROM track_files tf
      INNER JOIN tracks t ON t.id = tf.track_id
      WHERE t.source = 'tx' AND t.songmid = ?
    `).get(songmid) as { lyricsPath?: string } | undefined
    assert.equal(row?.lyricsPath, lyricsPath)
    const syncJob = db.prepare(`
      SELECT id
      FROM jobs
      WHERE type = 'sync_emby_track'
        AND json_extract(payload_json, '$.songmid') = ?
      LIMIT 1
    `).get(songmid)
    assert.ok(syncJob)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999046')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track' AND json_extract(payload_json, '$.songmid') = ?").run(songmid)
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
    rmSync(audioPath, { force: true })
    rmSync(lyricsPath, { force: true })
    rmSync(join(appConfig.musicDir, 'QQ Lyrics Artist'), { recursive: true, force: true })
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
    const historyBodies: any[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const request = new Request(url, init)
      requestUrls.push(request.url)
      const requestUrl = new URL(request.url)
      if (requestUrl.hostname === 'script.example') return new Response('https://cdn.example/audio.mp3')
      if (requestUrl.hostname === 'u.y.qq.com' && init?.body) {
        const body = JSON.parse(String(init.body))
        if (body.req?.module === 'music.musicasset.PlayRecentlyWrite') {
          historyBodies.push(body)
          return Response.json({ code: 0, req: { code: 0, data: { ret: 0 } } })
        }
      }
      return new Response('https://cdn.example/audio.mp3')
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Audio/${encodeURIComponent(songId)}/universal?api_key=${authPayload.AccessToken}`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Audio/${encodeURIComponent(songId)}/universal`),
    )
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), 'https://cdn.example/audio.mp3')

    await waitFor(() => historyBodies.length === 1)

    const continuation = await dispatchEmbyRequest(
      new Request(`http://local/emby/Audio/${encodeURIComponent(songId)}/universal?api_key=${authPayload.AccessToken}`, {
        headers: { 'X-Emby-Authorization': authHeader, range: 'bytes=1024-' },
      }),
      stripOptionalEmbyPrefix(`/emby/Audio/${encodeURIComponent(songId)}/universal`),
    )
    assert.equal(continuation.status, 302)
    await new Promise(resolve => setTimeout(resolve, 0))

    const playEvents = db.prepare(`
      SELECT COUNT(*) AS count
      FROM play_events pe
      INNER JOIN tracks t ON t.id = pe.track_id
      WHERE t.source = 'tx' AND t.songmid = 'qq-stream-song-1'
    `).get() as { count: number }
    assert.equal(playEvents.count, 1)
    assert.equal(historyBodies.length, 1)
    assert.equal(historyBodies[0].req.method, 'ReportPlayRecentlyInfo')
    assert.equal(historyBodies[0].req.param.data[0].id, '123')
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

test('local emby virtual audio GET fetches QQ metadata when cache is missing', async () => {
  const originalFetch = globalThis.fetch
  const originalLxMusicSourceScript = process.env.LX_MUSIC_SOURCE_SCRIPT
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999214')
    process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/script/lxmusic?key=test-key'
    saveQQLoginCookie('uin=o999214; qm_keyst=test-key')
    markAccountUpstreamBound('999214')
    const account = getAccountByQQ('999214')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const songmid = 'qq-audio-missing-cache'
    const songId = encodeVirtualId({ kind: 'qq-song', songmid })
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`
    const qqDetailRequests: string[] = []
    const requestedQualities: string[] = []

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        const body = typeof init?.body === 'string'
          ? JSON.parse(init.body) as {
            songinfo?: { param?: { song_mid?: string } }
            req?: { module?: string }
          }
          : {}
        if (body.req?.module === 'music.musicasset.PlayRecentlyWrite') {
          return Response.json({ code: 0, req: { code: 0, data: { ret: 0 } } })
        }
        qqDetailRequests.push(body.songinfo?.param?.song_mid ?? '')
        return Response.json({
          code: 0,
          songinfo: {
            code: 0,
            data: {
              track_info: {
                id: 214,
                mid: songmid,
                title: 'QQ Audio Missing Cache',
                interval: 188,
                singer: [{ name: 'QQ Audio Artist', mid: 'qq-audio-artist' }],
                album: { name: 'QQ Audio Album', mid: 'qq-audio-album' },
                file: { media_mid: 'qq-audio-media', size_128mp3: 1024, size_320mp3: 2048 },
              },
            },
          },
        })
      }
      if (requestUrl.hostname === 'script.example') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { quality?: string }
        requestedQualities.push(body.quality ?? '')
        return Response.json({ url: 'https://cdn.example/audio.mp3' })
      }
      if (requestUrl.hostname === 'cdn.example') return new Response('audio-from-cdn', { headers: { 'content-type': 'audio/mpeg' } })
      if (requestUrl.hostname === 'stat6.y.qq.com') return new Response('{}')
      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Audio/${encodeURIComponent(songId)}/universal?api_key=${authPayload.AccessToken}`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Audio/${encodeURIComponent(songId)}/universal`),
    )
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), 'https://cdn.example/audio.mp3')
    assert.deepEqual(qqDetailRequests, [songmid])
    assert.deepEqual(requestedQualities, ['320k'])
    const cached = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(`virtual.song.${songmid}`) as { value_json: string } | undefined
    assert.ok(cached)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999214')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('virtual.song.qq-audio-missing-cache')
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run('qq-audio-missing-cache')
    db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track' AND json_extract(payload_json, '$.songmid') = ?").run('qq-audio-missing-cache')
    globalThis.fetch = originalFetch
    if (originalLxMusicSourceScript === undefined) {
      delete process.env.LX_MUSIC_SOURCE_SCRIPT
    } else {
      process.env.LX_MUSIC_SOURCE_SCRIPT = originalLxMusicSourceScript
    }
  }
})

test('narjo virtual audio GET with extension suffix resolves upstream URL', async () => {
  const originalFetch = globalThis.fetch
  const originalLxMusicSourceScript = process.env.LX_MUSIC_SOURCE_SCRIPT
  const localAudioPath = join(process.cwd(), 'data/test-narjo-virtual-song.flac')
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999114')
    process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/script/lxmusic?key=test-key'
    saveQQLoginCookie('uin=o999114; qm_keyst=test-key')
    markAccountUpstreamBound('999114')
    const account = getAccountByQQ('999114')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const songId = encodeVirtualId({ kind: 'qq-song', songmid: 'qq-narjo-song-1' })
    const authHeader = `MediaBrowser Client="Narjo", Version="93", Device="iOS", Token="${authPayload.AccessToken}"`

    mkdirSync(join(process.cwd(), 'data'), { recursive: true })
    writeFileSync(localAudioPath, 'narjo-audio-bytes')
    const track = ensureTrack({
      source: 'tx',
      songmid: 'qq-narjo-song-1',
      name: 'Narjo Song',
      singer: 'QQ Artist',
      albumName: 'QQ Album',
      interval: '03:08',
      types: [{ type: 'flac', size: '1 MB' }, { type: '320k', size: '1 MB' }],
      raw: { songId: 321, songType: 0, strMediaMid: 'qq-media-narjo' },
    })
    upsertTrackFileStatus(track.id, 'flac', 'ready', { finalPath: localAudioPath, sizeBytes: 17, sha256: 'narjosha' })
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run('virtual.song.qq-narjo-song-1', JSON.stringify({
      song: {
        source: 'tx',
        songmid: 'qq-narjo-song-1',
        name: 'Narjo Song',
        singer: 'QQ Artist',
        albumName: 'QQ Album',
        interval: '03:08',
        types: [{ type: 'flac', size: '1 MB' }, { type: '320k', size: '1 MB' }],
        raw: { songId: 321, songType: 0, strMediaMid: 'qq-media-narjo' },
      },
    }))

    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'script.example') return Response.json({ url: 'https://cdn.example/narjo.flac' })
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/Audio/${encodeURIComponent(songId)}/universal.flac?DeviceId=Narjo-Device&api_key=${authPayload.AccessToken}`, {
        headers: { 'X-Emby-Authorization': authHeader, 'user-agent': 'Narjo/93' },
      }),
      stripOptionalEmbyPrefix(`/Audio/${encodeURIComponent(songId)}/universal.flac`),
    )
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('x-x-music-source'), 'upstream')
    assert.equal(response.headers.get('location'), 'https://cdn.example/narjo.flac')
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999114')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('virtual.song.qq-narjo-song-1')
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run('qq-narjo-song-1')
    db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track' AND json_extract(payload_json, '$.songmid') = ?").run('qq-narjo-song-1')
    rmSync(localAudioPath, { force: true })
    globalThis.fetch = originalFetch
    if (originalLxMusicSourceScript === undefined) {
      delete process.env.LX_MUSIC_SOURCE_SCRIPT
    } else {
      process.env.LX_MUSIC_SOURCE_SCRIPT = originalLxMusicSourceScript
    }
  }
})

test('narjo mp3 audio request falls back to higher quality when mp3 URL fails', async () => {
  const originalFetch = globalThis.fetch
  const originalLxMusicSourceScript = process.env.LX_MUSIC_SOURCE_SCRIPT
  const songmid = `qq-narjo-mp3-fallback-${Date.now()}`
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999118')
    process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/script/lxmusic?key=test-key'
    saveQQLoginCookie('uin=o999118; qm_keyst=test-key')
    markAccountUpstreamBound('999118')
    const account = getAccountByQQ('999118')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const songId = encodeVirtualId({ kind: 'qq-song', songmid })
    const authHeader = `MediaBrowser Client="Narjo", Version="93", Device="iOS", Token="${authPayload.AccessToken}"`
    const song: MusicInfo = {
      source: 'tx',
      songmid,
      name: 'Narjo MP3 Fallback Song',
      singer: 'QQ Artist',
      interval: '03:08',
      types: [{ type: 'flac', size: '49 MB' }, { type: '320k', size: '5 MB' }],
    }
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({ song }))

    const requestedQualities: string[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'script.example') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { quality?: string }
        requestedQualities.push(body.quality ?? '')
        if (body.quality === '320k') throw new TypeError('fetch failed')
        return Response.json({ url: `https://cdn.example/audio-${body.quality}.flac` })
      }
      if (requestUrl.hostname === 'cdn.example') {
        return new Response(`audio-${requestUrl.pathname}`, { headers: { 'content-type': 'audio/flac' } })
      }
      if (requestUrl.hostname === 'stat6.y.qq.com') return new Response('{}')
      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/Audio/${encodeURIComponent(songId)}/universal.mp3?api_key=${authPayload.AccessToken}`, {
        headers: { 'X-Emby-Authorization': authHeader, 'user-agent': 'Narjo/93' },
      }),
      stripOptionalEmbyPrefix(`/Audio/${encodeURIComponent(songId)}/universal.mp3`),
    )
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), 'https://cdn.example/audio-flac.flac')
    assert.deepEqual(requestedQualities, ['320k', 'flac'])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999118')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)
    db.prepare("DELETE FROM jobs WHERE json_extract(payload_json, '$.songmid') = ?").run(songmid)
    globalThis.fetch = originalFetch
    if (originalLxMusicSourceScript === undefined) {
      delete process.env.LX_MUSIC_SOURCE_SCRIPT
    } else {
      process.env.LX_MUSIC_SOURCE_SCRIPT = originalLxMusicSourceScript
    }
  }
})

test('local emby virtual audio GET returns playable errors as 502 JSON', async () => {
  const originalFetch = globalThis.fetch
  const originalLxMusicSourceScript = process.env.LX_MUSIC_SOURCE_SCRIPT
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999025')
    process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/script/lxmusic?key=test-key'
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
      if (requestUrl.hostname === 'script.example') return Response.json({ error: 'upstream unavailable' }, { status: 502 })
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
    assert.match(payload.error, /music-url API returned 502/)
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

test('local emby virtual audio caches unavailable music-url responses as 451', async () => {
  const originalFetch = globalThis.fetch
  const originalLxMusicSourceScript = process.env.LX_MUSIC_SOURCE_SCRIPT
  const songmid = `qq-unavailable-song-${Date.now()}`
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999121')
    process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/script/lxmusic?key=test-key'
    saveQQLoginCookie('uin=o999121; qm_keyst=test-key')
    markAccountUpstreamBound('999121')
    const account = getAccountByQQ('999121')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const songId = encodeVirtualId({ kind: 'qq-song', songmid })
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`

    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({
      song: {
        source: 'tx',
        songmid,
        name: 'QQ Unavailable Song',
        singer: 'QQ Artist',
        interval: '03:08',
        types: [{ type: 'flac', size: '10 MB' }, { type: '320k', size: '5 MB' }, { type: '128k', size: '1 MB' }],
      },
    }))

    let musicUrlRequests = 0
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'script.example') {
        musicUrlRequests += 1
        return Response.json({ code: 500, message: 'ERR无版权' })
      }
      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const first = await dispatchEmbyRequest(
      new Request(`http://local/emby/Audio/${encodeURIComponent(songId)}/universal?api_key=${authPayload.AccessToken}`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Audio/${encodeURIComponent(songId)}/universal`),
    )
    assert.equal(first.status, 451)
    assert.match((await first.json()).error, /ERR无版权/)
    assert.equal(musicUrlRequests, 3)

    const second = await dispatchEmbyRequest(
      new Request(`http://local/emby/Audio/${encodeURIComponent(songId)}/universal?api_key=${authPayload.AccessToken}`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Audio/${encodeURIComponent(songId)}/universal`),
    )
    assert.equal(second.status, 451)
    assert.equal(musicUrlRequests, 6)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999121')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM app_settings WHERE key LIKE ?").run(`music-url.unplayable.tx.${songmid}%`)
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)
    db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track' AND json_extract(payload_json, '$.songmid') = ?").run(songmid)
    globalThis.fetch = originalFetch
    if (originalLxMusicSourceScript === undefined) {
      delete process.env.LX_MUSIC_SOURCE_SCRIPT
    } else {
      process.env.LX_MUSIC_SOURCE_SCRIPT = originalLxMusicSourceScript
    }
  }
})

test('local emby virtual audio ignores stale whole-song unavailable cache when URL is playable', async () => {
  const originalFetch = globalThis.fetch
  const originalLxMusicSourceScript = process.env.LX_MUSIC_SOURCE_SCRIPT
  const songmid = `qq-stale-unavailable-song-${Date.now()}`
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999122')
    process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/script/lxmusic?key=test-key'
    saveQQLoginCookie('uin=o999122; qm_keyst=test-key')
    markAccountUpstreamBound('999122')
    const account = getAccountByQQ('999122')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const songId = encodeVirtualId({ kind: 'qq-song', songmid })
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`

    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({
      song: {
        source: 'tx',
        songmid,
        name: 'QQ Stale Unavailable Song',
        singer: 'QQ Artist',
        interval: '03:08',
        types: [{ type: 'flac', size: '10 MB' }, { type: '320k', size: '5 MB' }],
      },
    }))
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`music-url.unplayable.tx.${songmid}`, JSON.stringify({
      source: 'tx',
      songmid,
      reason: 'stale whole-song unavailable cache',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }))

    let musicUrlRequests = 0
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'script.example') {
        musicUrlRequests += 1
        const body = JSON.parse(String(init?.body ?? '{}')) as { quality?: string }
        return Response.json({ url: `https://cdn.example/${body.quality}.flac` })
      }
      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Audio/${encodeURIComponent(songId)}/universal?api_key=${authPayload.AccessToken}`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Audio/${encodeURIComponent(songId)}/universal`),
    )
    assert.equal(response.status, 302)
    assert.match(response.headers.get('location') ?? '', /cdn\.example/)
    assert.equal(musicUrlRequests, 1)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999122')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM app_settings WHERE key LIKE ?").run(`music-url.unplayable.tx.${songmid}%`)
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)
    db.prepare("DELETE FROM jobs WHERE json_extract(payload_json, '$.songmid') = ?").run(songmid)
    globalThis.fetch = originalFetch
    if (originalLxMusicSourceScript === undefined) {
      delete process.env.LX_MUSIC_SOURCE_SCRIPT
    } else {
      process.env.LX_MUSIC_SOURCE_SCRIPT = originalLxMusicSourceScript
    }
  }
})

test('local emby virtual audio retries stale quality unavailable cache before returning 451', async () => {
  const originalFetch = globalThis.fetch
  const originalLxMusicSourceScript = process.env.LX_MUSIC_SOURCE_SCRIPT
  const songmid = `qq-stale-quality-unavailable-song-${Date.now()}`
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999123')
    process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/script/lxmusic?key=test-key'
    saveQQLoginCookie('uin=o999123; qm_keyst=test-key')
    markAccountUpstreamBound('999123')
    const account = getAccountByQQ('999123')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const songId = encodeVirtualId({ kind: 'qq-song', songmid })
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`

    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({
      song: {
        source: 'tx',
        songmid,
        name: 'QQ Stale Quality Unavailable Song',
        singer: 'QQ Artist',
        interval: '03:08',
        types: [{ type: 'flac', size: '10 MB' }, { type: '320k', size: '5 MB' }, { type: '128k', size: '1 MB' }],
      },
    }))
    for (const quality of ['flac', '320k', '128k']) {
      db.prepare(`
        INSERT INTO app_settings (key, value_json, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
      `).run(`music-url.unplayable.tx.${songmid}.${quality}`, JSON.stringify({
        source: 'tx',
        songmid,
        quality,
        reason: 'stale quality unavailable cache',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }))
    }

    let musicUrlRequests = 0
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'script.example') {
        musicUrlRequests += 1
        const body = JSON.parse(String(init?.body ?? '{}')) as { quality?: string }
        return Response.json({ url: `https://cdn.example/${body.quality}.flac` })
      }
      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Audio/${encodeURIComponent(songId)}/universal?api_key=${authPayload.AccessToken}`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Audio/${encodeURIComponent(songId)}/universal`),
    )
    assert.equal(response.status, 302)
    assert.match(response.headers.get('location') ?? '', /cdn\.example/)
    assert.equal(musicUrlRequests, 1)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999123')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM app_settings WHERE key LIKE ?").run(`music-url.unplayable.tx.${songmid}%`)
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)
    db.prepare("DELETE FROM jobs WHERE json_extract(payload_json, '$.songmid') = ?").run(songmid)
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
    process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/script/lxmusic?key=test-key'
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
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'script.example') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { quality?: string }
        requestedQualities.push(body.quality ?? '')
        return Response.json({ url: 'https://cdn.example/audio.mp3' })
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
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), 'https://cdn.example/audio.mp3')
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

test('ampcast virtual audio refreshes flac instead of serving lower local fallback', async () => {
  const originalFetch = globalThis.fetch
  const originalLxMusicSourceScript = process.env.LX_MUSIC_SOURCE_SCRIPT
  const songmid = `qq-ampcast-flac-${Date.now()}`
  const oggPath = join(process.cwd(), `data/test-${songmid}.ogg`)
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999047')
    process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/script/lxmusic?key=test-key'
    saveQQLoginCookie('uin=o999047; qm_keyst=test-key')
    markAccountUpstreamBound('999047')
    const account = getAccountByQQ('999047')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const songId = encodeVirtualId({ kind: 'qq-song', songmid })
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`
    const song: MusicInfo = {
      source: 'tx',
      songmid,
      name: 'Ampcast Flac Song',
      singer: 'QQ Artist',
      interval: '03:08',
      types: [{ type: 'flac', size: '49 MB' }, { type: '320k', size: '5 MB' }],
    }
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({ song }))

    mkdirSync(join(process.cwd(), 'data'), { recursive: true })
    writeFileSync(oggPath, 'ogg-bytes')
    const track = ensureTrack(song)
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: oggPath, sizeBytes: 9 })

    const requestedQualities: string[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'script.example') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { quality?: string }
        requestedQualities.push(body.quality ?? '')
        return Response.json({ url: 'https://cdn.example/audio.flac' })
      }
      if (requestUrl.hostname === 'cdn.example') {
        return new Response('flac-bytes', { headers: { 'content-type': 'audio/flac' } })
      }
      if (requestUrl.hostname === 'stat6.y.qq.com') return new Response('{}')
      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const head = await dispatchEmbyRequest(
      new Request(`http://local/emby/Audio/${encodeURIComponent(songId)}/universal?Container=opus%2Cwebm%7Copus%2Cmp3%2Caac%2Cflac&AudioCodec=aac&api_key=${authPayload.AccessToken}`, {
        method: 'HEAD',
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Audio/${encodeURIComponent(songId)}/universal`),
    )
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-type'), 'audio/mpeg')
    assert.equal(head.headers.get('x-x-music-source'), 'upstream')

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Audio/${encodeURIComponent(songId)}/universal?Container=opus%2Cwebm%7Copus%2Cmp3%2Caac%2Cflac&AudioCodec=aac&api_key=${authPayload.AccessToken}`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Audio/${encodeURIComponent(songId)}/universal`),
    )
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), 'https://cdn.example/audio.flac')
    assert.deepEqual(requestedQualities, ['flac'])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999047')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)
    db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track' AND json_extract(payload_json, '$.songmid') = ?").run(songmid)
    rmSync(oggPath, { force: true })
    globalThis.fetch = originalFetch
    if (originalLxMusicSourceScript === undefined) {
      delete process.env.LX_MUSIC_SOURCE_SCRIPT
    } else {
      process.env.LX_MUSIC_SOURCE_SCRIPT = originalLxMusicSourceScript
    }
  }
})

test('ampcast virtual audio prefers QQ LX before local mapped Emby item', async () => {
  const originalFetch = globalThis.fetch
  const originalLxMusicSourceScript = process.env.LX_MUSIC_SOURCE_SCRIPT
  const songmid = `qq-ampcast-mapped-low-${Date.now()}`
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999048')
    process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/script/lxmusic?key=test-key'
    saveQQLoginCookie('uin=o999048; qm_keyst=test-key')
    markAccountUpstreamBound('999048')
    const account = getAccountByQQ('999048')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const songId = encodeVirtualId({ kind: 'qq-song', songmid })
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`
    const song: MusicInfo = {
      source: 'tx',
      songmid,
      name: 'Ampcast Mapped Low Song',
      singer: 'QQ Artist',
      interval: '03:08',
      types: [{ type: 'flac', size: '49 MB' }, { type: '320k', size: '5 MB' }],
    }
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({ song }))
    upsertRemoteMapping({
      localType: 'track',
      localKey: `tx:${songmid}`,
      remote: 'emby',
      remoteId: 'emby-low-ogg-item',
      raw: song,
    })

    const itemInfoRequests: string[] = []
    const requestedQualities: string[] = []
    const proxiedAudioPaths: string[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'script.example') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { quality?: string }
        requestedQualities.push(body.quality ?? '')
        return Response.json({ url: 'https://cdn.example/audio.flac' })
      }
      if (requestUrl.hostname === 'cdn.example') {
        return new Response('flac-bytes', { headers: { 'content-type': 'audio/flac' } })
      }
      if (requestUrl.pathname.endsWith('/Items/emby-low-ogg-item')) {
        itemInfoRequests.push(requestUrl.pathname)
        return Response.json({ error: 'media info should not be fetched for a local mapping' }, { status: 500 })
      }
      if (requestUrl.pathname.includes('/Audio/emby-low-ogg-item/')) {
        proxiedAudioPaths.push(requestUrl.pathname)
        return new Response('ogg-from-emby', { headers: { 'content-type': 'audio/ogg' } })
      }
      if (requestUrl.hostname === 'stat6.y.qq.com') return new Response('{}')
      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Audio/${encodeURIComponent(songId)}/universal?Container=opus%2Cwebm%7Copus%2Cmp3%2Caac%2Cflac&AudioCodec=aac&api_key=${authPayload.AccessToken}`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Audio/${encodeURIComponent(songId)}/universal`),
    )
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), 'https://cdn.example/audio.flac')
    assert.deepEqual(itemInfoRequests, [])
    assert.deepEqual(requestedQualities, ['flac'])
    assert.deepEqual(proxiedAudioPaths, [])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999048')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)
    db.prepare("DELETE FROM remote_mappings WHERE local_type = 'track' AND local_key = ? AND remote = 'emby'").run(`tx:${songmid}`)
    db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track' AND json_extract(payload_json, '$.songmid') = ?").run(songmid)
    globalThis.fetch = originalFetch
    if (originalLxMusicSourceScript === undefined) {
      delete process.env.LX_MUSIC_SOURCE_SCRIPT
    } else {
      process.env.LX_MUSIC_SOURCE_SCRIPT = originalLxMusicSourceScript
    }
  }
})

test('local emby audio prefers QQ LX for stale mapped Emby ids', async () => {
  const originalFetch = globalThis.fetch
  const originalLxMusicSourceScript = process.env.LX_MUSIC_SOURCE_SCRIPT
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999049')
    db.prepare("DELETE FROM remote_mappings WHERE remote = 'emby' AND remote_id = ?").run('11783440')
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('stale-emby-track.11783440')
    process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/script/lxmusic?key=test-key'
    saveQQLoginCookie('uin=o999049; qm_keyst=test-key')
    markAccountUpstreamBound('999049', 'emby-user-999049', 'upstream-user-token-999049')
    const account = getAccountByQQ('999049')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run('stale-emby-track.11783440', JSON.stringify({
      source: 'tx',
      songmid: '0016fIIL1ohNNR',
      staleRemoteId: '11783440',
    }))
    rememberTestVirtualSong({
      source: 'tx',
      songmid: '0016fIIL1ohNNR',
      name: '舞女 (Live)',
      singer: '朱咪咪',
      albumName: '咪咪[咪]玩嘢2008演唱会 (Live)',
      interval: '06:27',
      types: [{ type: 'flac', size: '77 MB' }, { type: '320k', size: '14 MB' }, { type: '128k', size: '5 MB' }],
    })

    const proxiedAudioPaths: string[] = []
    const lxRequests: string[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'script.example') {
        lxRequests.push(String(url))
        const body = JSON.parse(String(init?.body ?? '{}')) as { musicId?: string; quality?: string }
        assert.equal(body.musicId, '0016fIIL1ohNNR')
        return Response.json({ url: `https://cdn.example/${body.quality}.flac` })
      }
      if (requestUrl.pathname === '/Audio/11783440/universal') {
        proxiedAudioPaths.push(requestUrl.pathname)
        return new Response('emby-upstream-audio', {
          status: 206,
          headers: {
            'content-type': 'audio/flac',
            'content-range': 'bytes 0-18/19',
            'accept-ranges': 'bytes',
          },
        })
      }
      return Response.json({ error: 'unexpected upstream request' }, { status: 500 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Audio/11783440/universal?MaxStreamingBitrate=140000000&api_key=${authPayload.AccessToken}`, {
        headers: {
          'X-Emby-Authorization': authHeader,
          range: 'bytes=0-',
        },
      }),
      stripOptionalEmbyPrefix('/emby/Audio/11783440/universal'),
    )
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('x-x-music-source'), 'upstream')
    assert.equal(response.headers.get('location'), 'https://cdn.example/flac.flac')
    assert.deepEqual(proxiedAudioPaths, [])
    assert.deepEqual(lxRequests.length, 1)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999049')
    db.prepare("DELETE FROM remote_mappings WHERE remote = 'emby' AND remote_id = ?").run('11783440')
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('stale-emby-track.11783440')
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('virtual.song.0016fIIL1ohNNR')
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
    if (originalLxMusicSourceScript === undefined) {
      delete process.env.LX_MUSIC_SOURCE_SCRIPT
    } else {
      process.env.LX_MUSIC_SOURCE_SCRIPT = originalLxMusicSourceScript
    }
  }
})

test('local emby audio falls back to upstream Emby when QQ LX is unavailable', async () => {
  const originalFetch = globalThis.fetch
  const originalLxMusicSourceScript = process.env.LX_MUSIC_SOURCE_SCRIPT
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999050')
    db.prepare("DELETE FROM remote_mappings WHERE remote = 'emby' AND remote_id = ?").run('11783440')
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('stale-emby-track.11783440')
    process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/script/lxmusic?key=test-key'
    saveQQLoginCookie('uin=o999050; qm_keyst=test-key')
    markAccountUpstreamBound('999050', 'emby-user-999050', 'upstream-user-token-999050')
    const account = getAccountByQQ('999050')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run('stale-emby-track.11783440', JSON.stringify({
      source: 'tx',
      songmid: '0016fIIL1ohNNR',
      staleRemoteId: '11783440',
    }))
    rememberTestVirtualSong({
      source: 'tx',
      songmid: '0016fIIL1ohNNR',
      name: '舞女 (Live)',
      singer: '朱咪咪',
      albumName: '咪咪[咪]玩嘢2008演唱会 (Live)',
      interval: '06:27',
      types: [{ type: 'flac', size: '77 MB' }, { type: '320k', size: '14 MB' }, { type: '128k', size: '5 MB' }],
    })

    const lxRequests: string[] = []
    const proxiedAudioPaths: string[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'script.example') {
        lxRequests.push(String(url))
        return Response.json({ code: 500, message: '未获取到URL' })
      }
      if (requestUrl.pathname === '/Items' && requestUrl.searchParams.get('SearchTerm') === '舞女 (Live)') {
        return Response.json({ Items: [{ Id: '11783440', Name: '舞女 (Live)', Type: 'Audio', Artists: ['朱咪咪'] }] })
      }
      if (requestUrl.pathname === '/Audio/11783440/universal') {
        proxiedAudioPaths.push(requestUrl.pathname)
        assert.equal(requestUrl.searchParams.get('api_key'), 'upstream-user-token-999050')
        assert.equal(new Headers(init?.headers).get('range'), 'bytes=0-')
        return new Response('emby-fallback-audio', {
          status: 206,
          headers: {
            'content-type': 'audio/flac',
            'content-range': 'bytes 0-18/19',
            'accept-ranges': 'bytes',
          },
        })
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Audio/11783440/universal?api_key=${authPayload.AccessToken}`, {
        headers: { range: 'bytes=0-' },
      }),
      stripOptionalEmbyPrefix('/emby/Audio/11783440/universal'),
    )
    assert.equal(response.status, 206)
    assert.equal(await response.text(), 'emby-fallback-audio')
    assert.equal(lxRequests.length, 3)
    assert.deepEqual(proxiedAudioPaths, ['/Audio/11783440/universal'])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999050')
    db.prepare("DELETE FROM remote_mappings WHERE remote = 'emby' AND remote_id = ?").run('11783440')
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('stale-emby-track.11783440')
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('virtual.song.0016fIIL1ohNNR')
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
    if (originalLxMusicSourceScript === undefined) {
      delete process.env.LX_MUSIC_SOURCE_SCRIPT
    } else {
      process.env.LX_MUSIC_SOURCE_SCRIPT = originalLxMusicSourceScript
    }
  }
})

test('local emby audio proxies unknown upstream Emby ids directly', async () => {
  const originalFetch = globalThis.fetch
  const originalLxMusicSourceScript = process.env.LX_MUSIC_SOURCE_SCRIPT
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999051')
    db.prepare("DELETE FROM remote_mappings WHERE remote = 'emby' AND remote_id = ?").run('emby-unknown-audio')
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('stale-emby-track.emby-unknown-audio')
    process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/script/lxmusic?key=test-key'
    saveQQLoginCookie('uin=o999051; qm_keyst=test-key')
    markAccountUpstreamBound('999051', 'emby-user-999051', 'upstream-user-token-999051')
    const account = getAccountByQQ('999051')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()

    const lxRequests: string[] = []
    const proxiedAudioPaths: string[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'script.example') lxRequests.push(String(url))
      if (requestUrl.pathname === '/Audio/emby-unknown-audio/universal') {
        proxiedAudioPaths.push(requestUrl.pathname)
        assert.equal(new Headers(init?.headers).get('range'), 'bytes=0-')
        return new Response('unknown-emby-audio', { status: 206, headers: { 'content-type': 'audio/flac' } })
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Audio/emby-unknown-audio/universal?api_key=${authPayload.AccessToken}`, {
        headers: { range: 'bytes=0-' },
      }),
      stripOptionalEmbyPrefix('/emby/Audio/emby-unknown-audio/universal'),
    )
    assert.equal(response.status, 206)
    assert.equal(await response.text(), 'unknown-emby-audio')
    assert.deepEqual(proxiedAudioPaths, ['/Audio/emby-unknown-audio/universal'])
    assert.deepEqual(lxRequests, [])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999051')
    db.prepare("DELETE FROM remote_mappings WHERE remote = 'emby' AND remote_id = ?").run('emby-unknown-audio')
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('stale-emby-track.emby-unknown-audio')
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
    if (originalLxMusicSourceScript === undefined) {
      delete process.env.LX_MUSIC_SOURCE_SCRIPT
    } else {
      process.env.LX_MUSIC_SOURCE_SCRIPT = originalLxMusicSourceScript
    }
  }
})

test('virtual favorite add enqueues track archive job', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `archive-favorite-${Date.now()}`
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999902')
    db.prepare("DELETE FROM jobs WHERE type = 'archive_track' AND json_extract(payload_json, '$.songmid') = ?").run(songmid)
    saveQQLoginCookie('uin=o999902; euin=encrypted999902; qm_keyst=test-key')
    markAccountUpstreamBound('999902')
    configureAccountUpstreamWebdav('999902')
    const account = getAccountByQQ('999902')
    assert.ok(account)
    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const song: MusicInfo = {
      source: 'tx',
      songmid,
      name: 'Archive Favorite Song',
      singer: 'Archive Artist',
      raw: { songId: 123456, songType: 0 },
    }
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({ song }))
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') return Response.json({ code: 0, req: { code: 0, data: { result: 0 } } })
      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const virtualId = encodeVirtualId({ kind: 'qq-song', songmid })
    const response = await dispatchEmbyRequest(
      new Request(`http://local/Users/${authPayload.User.Id}/FavoriteItems/${encodeURIComponent(virtualId)}`, {
        method: 'POST',
        headers: { 'X-Emby-Token': authPayload.AccessToken },
      }),
      `/Users/${authPayload.User.Id}/FavoriteItems/${encodeURIComponent(virtualId)}`,
    )
    assert.equal(response.status, 200)
    const archiveJob = db.prepare(`
      SELECT payload_json AS payloadJson
      FROM jobs
      WHERE type = 'archive_track'
        AND json_extract(payload_json, '$.songmid') = ?
      LIMIT 1
    `).get(songmid) as { payloadJson: string } | undefined
    const archivePayload = JSON.parse(archiveJob?.payloadJson ?? '{}') as { reason?: string; playlistId?: string; qqUin?: string }
    assert.equal(archivePayload.reason, 'favorite')
    assert.equal(archivePayload.qqUin, undefined)

    const syncJob = db.prepare(`
      SELECT user_id AS userId, payload_json AS payloadJson
      FROM jobs
      WHERE type = 'sync_emby_track'
        AND json_extract(payload_json, '$.songmid') = ?
      LIMIT 1
    `).get(songmid) as { userId: string; payloadJson: string } | undefined
    assert.equal(syncJob?.userId, '999902')
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999902')
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM jobs WHERE json_extract(payload_json, '$.songmid') = ?").run(songmid)
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('virtual favorite remove does not enqueue track archive jobs when WebDAV is configured', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `archive-unfavorite-${Date.now()}`
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999901')
    db.prepare("DELETE FROM jobs WHERE json_extract(payload_json, '$.songmid') = ?").run(songmid)
    saveQQLoginCookie('uin=o999901; euin=encrypted999901; qm_keyst=test-key')
    markAccountUpstreamBound('999901')
    configureAccountUpstreamWebdav('999901')
    const account = getAccountByQQ('999901')
    assert.ok(account)
    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const song: MusicInfo = {
      source: 'tx',
      songmid,
      name: 'Archive Unfavorite Song',
      singer: 'Archive Artist',
      raw: { songId: 123457, songType: 0 },
    }
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({ song }))
    setLocalFavoriteSynced(song, true, '999901')
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') return Response.json({ code: 0, req: { code: 0, data: { result: 0 } } })
      if (requestUrl.pathname.includes('/FavoriteItems/')) return new Response(null, { status: 204 })
      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const virtualId = encodeVirtualId({ kind: 'qq-song', songmid })
    const response = await dispatchEmbyRequest(
      new Request(`http://local/Users/${authPayload.User.Id}/FavoriteItems/${encodeURIComponent(virtualId)}`, {
        method: 'DELETE',
        headers: { 'X-Emby-Token': authPayload.AccessToken },
      }),
      `/Users/${authPayload.User.Id}/FavoriteItems/${encodeURIComponent(virtualId)}`,
    )
    assert.equal(response.status, 200)
    const archiveJob = db.prepare(`
      SELECT COUNT(*) AS count
      FROM jobs
      WHERE type = 'archive_track'
        AND json_extract(payload_json, '$.songmid') = ?
    `).get(songmid) as { count: number }
    assert.equal(archiveJob.count, 0)

    const syncJob = db.prepare(`
      SELECT COUNT(*) AS count
      FROM jobs
      WHERE type = 'sync_emby_track'
        AND json_extract(payload_json, '$.songmid') = ?
    `).get(songmid) as { count: number }
    assert.equal(syncJob.count, 0)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999901')
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM jobs WHERE json_extract(payload_json, '$.songmid') = ?").run(songmid)
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('virtual playback stopped report enqueues track archive and sync jobs when WebDAV is configured', async () => {
  const songmid = `archive-stopped-${Date.now()}`
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999903')
    db.prepare("DELETE FROM jobs WHERE json_extract(payload_json, '$.songmid') = ?").run(songmid)
    saveQQLoginCookie('uin=o999903; qm_keyst=test-key')
    markAccountUpstreamBound('999903')
    configureAccountUpstreamWebdav('999903')
    const account = getAccountByQQ('999903')
    assert.ok(account)
    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const song: MusicInfo = {
      source: 'tx',
      songmid,
      name: 'Archive Stopped Song',
      singer: 'Archive Artist',
      types: [{ type: '320k', size: '1 MB' }],
    }
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({ song }))
    const virtualId = encodeVirtualId({ kind: 'qq-song', songmid })

    const response = await dispatchEmbyRequest(
      new Request(`http://local/Sessions/Playing/Stopped?api_key=${authPayload.AccessToken}`, {
        method: 'POST',
        body: JSON.stringify({ ItemId: virtualId }),
      }),
      '/Sessions/Playing/Stopped',
    )
    assert.equal(response.status, 204)
    const archiveJob = db.prepare(`
      SELECT payload_json AS payloadJson
      FROM jobs
      WHERE type = 'archive_track'
        AND json_extract(payload_json, '$.songmid') = ?
      LIMIT 1
    `).get(songmid) as { payloadJson: string } | undefined
    const archivePayload = JSON.parse(archiveJob?.payloadJson ?? '{}') as { reason?: string; qqUin?: string }
    assert.equal(archivePayload.reason, 'playback_completed')
    assert.equal(archivePayload.qqUin, undefined)

    const syncJob = db.prepare(`
      SELECT user_id AS userId, payload_json AS payloadJson
      FROM jobs
      WHERE type = 'sync_emby_track'
        AND json_extract(payload_json, '$.songmid') = ?
      LIMIT 1
    `).get(songmid) as { userId: string; payloadJson: string } | undefined
    const syncPayload = JSON.parse(syncJob?.payloadJson ?? '{}') as { allowCachedQualityFallback?: boolean }
    assert.equal(syncJob?.userId, '999903')
    assert.equal(syncPayload.allowCachedQualityFallback, true)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999903')
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM jobs WHERE json_extract(payload_json, '$.songmid') = ?").run(songmid)
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
    clearQQLoginCookie()
  }
})

test('virtual favorite and playback enqueue archive jobs with WebDAV-only Emby source', async () => {
  const originalFetch = globalThis.fetch
  const favoriteSongmid = `archive-webdav-only-favorite-${Date.now()}`
  const stoppedSongmid = `archive-webdav-only-stopped-${Date.now()}`
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999904')
    db.prepare("DELETE FROM jobs WHERE json_extract(payload_json, '$.songmid') IN (?, ?)").run(favoriteSongmid, stoppedSongmid)
    saveQQLoginCookie('uin=o999904; euin=encrypted999904; qm_keyst=test-key')
    configureAccountUpstreamWebdav('999904')
    const account = getAccountByQQ('999904')
    assert.ok(account)
    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const favoriteSong: MusicInfo = {
      source: 'tx',
      songmid: favoriteSongmid,
      name: 'WebDAV Only Favorite Song',
      singer: 'Archive Artist',
      raw: { songId: 123458, songType: 0 },
    }
    const stoppedSong: MusicInfo = {
      source: 'tx',
      songmid: stoppedSongmid,
      name: 'WebDAV Only Stopped Song',
      singer: 'Archive Artist',
      types: [{ type: '320k', size: '1 MB' }],
    }
    for (const song of [favoriteSong, stoppedSong]) {
      db.prepare(`
        INSERT INTO app_settings (key, value_json, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
      `).run(`virtual.song.${song.songmid}`, JSON.stringify({ song }))
    }
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') return Response.json({ code: 0, req: { code: 0, data: { result: 0 } } })
      return Response.json({ error: 'should not require upstream Emby' }, { status: 500 })
    }) as typeof fetch

    const favoriteId = encodeVirtualId({ kind: 'qq-song', songmid: favoriteSongmid })
    const favoriteResponse = await dispatchEmbyRequest(
      new Request(`http://local/Users/${authPayload.User.Id}/FavoriteItems/${encodeURIComponent(favoriteId)}`, {
        method: 'POST',
        headers: { 'X-Emby-Token': authPayload.AccessToken },
      }),
      `/Users/${authPayload.User.Id}/FavoriteItems/${encodeURIComponent(favoriteId)}`,
    )
    assert.equal(favoriteResponse.status, 200)

    const stoppedId = encodeVirtualId({ kind: 'qq-song', songmid: stoppedSongmid })
    const stoppedResponse = await dispatchEmbyRequest(
      new Request(`http://local/Sessions/Playing/Stopped?api_key=${authPayload.AccessToken}`, {
        method: 'POST',
        body: JSON.stringify({ ItemId: stoppedId }),
      }),
      '/Sessions/Playing/Stopped',
    )
    assert.equal(stoppedResponse.status, 204)

    const archiveJobs = db.prepare(`
      SELECT payload_json AS payloadJson
      FROM jobs
      WHERE type = 'archive_track'
        AND json_extract(payload_json, '$.songmid') IN (?, ?)
      ORDER BY json_extract(payload_json, '$.songmid')
    `).all(favoriteSongmid, stoppedSongmid) as Array<{ payloadJson: string }>
    assert.deepEqual(
      archiveJobs.map(job => {
        const payload = JSON.parse(job.payloadJson) as { songmid: string; reason: string; qqUin?: string }
        return [payload.songmid, payload.reason, payload.qqUin]
      }),
      [
        [favoriteSongmid, 'favorite', undefined],
        [stoppedSongmid, 'playback_completed', undefined],
      ],
    )
    const syncJobs = db.prepare(`
      SELECT COUNT(*) AS count
      FROM jobs
      WHERE type = 'sync_emby_track'
        AND json_extract(payload_json, '$.songmid') IN (?, ?)
    `).get(favoriteSongmid, stoppedSongmid) as { count: number }
    assert.equal(syncJobs.count, 2)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999904')
    db.prepare('DELETE FROM app_settings WHERE key IN (?, ?)').run(`virtual.song.${favoriteSongmid}`, `virtual.song.${stoppedSongmid}`)
    db.prepare("DELETE FROM jobs WHERE json_extract(payload_json, '$.songmid') IN (?, ?)").run(favoriteSongmid, stoppedSongmid)
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid IN (?, ?)").run(favoriteSongmid, stoppedSongmid)
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('stale mapped Emby item detail falls back to QQ and removes mapping', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `qq-mapped-report-${Date.now()}`
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999119')
    saveQQLoginCookie('uin=o999119; qm_keyst=test-key')
    markAccountUpstreamBound('999119')
    const account = getAccountByQQ('999119')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`
    const song: MusicInfo = {
      source: 'tx',
      songmid,
      name: 'Mapped Report Song',
      singer: 'QQ Artist',
      albumName: 'QQ Album',
      albumId: 'qq-album',
      interval: '03:08',
      types: [{ type: '320k', size: '1 MB' }],
    }
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({ song }))
    upsertRemoteMapping({
      localType: 'track',
      localKey: `tx:${songmid}`,
      remote: 'emby',
      remoteId: 'stale-emby-mapped-report-item',
      raw: song,
    })

    const upstreamRequests: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
        return Response.json({
          code: 0,
          lyric: {
            code: 0,
            data: {
              lyric: '[00:01.00]映射歌词',
            },
          },
        })
      }
      upstreamRequests.push(String(url))
      return new Response('stale upstream item should not be requested', { status: 500 })
    }) as typeof fetch

    const detail = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items/stale-emby-mapped-report-item`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items/stale-emby-mapped-report-item`),
    )
    assert.equal(detail.status, 200)
    const detailPayload = await detail.json()
    assert.equal(detailPayload.Name, 'Mapped Report Song')
    assert.match(detailPayload.Id, /^mix_/)
    assert.equal(detailPayload.MediaSources[0].Id, detailPayload.Id)
    assert.equal(detailPayload.MediaSources[0].Path, `/Audio/${encodeURIComponent(detailPayload.Id)}/universal`)
    assert.equal(detailPayload.HasLyrics, true)
    assert.equal(detailPayload.MediaSources[0].MediaStreams[1].DeliveryUrl, `/Items/${encodeURIComponent(detailPayload.Id)}/Subtitles/1/Stream.js`)
    const mappingCount = db.prepare("SELECT COUNT(*) AS count FROM remote_mappings WHERE local_type = 'track' AND local_key = ? AND remote = 'emby'").get(`tx:${songmid}`) as { count: number }
    assert.equal(mappingCount.count, 0)
    const staleAlias = db.prepare('SELECT value_json AS valueJson FROM app_settings WHERE key = ?').get('stale-emby-track.stale-emby-mapped-report-item') as { valueJson?: string } | undefined
    assert.equal(JSON.parse(staleAlias?.valueJson ?? '{}').songmid, songmid)

    const repeatDetail = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items/stale-emby-mapped-report-item`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items/stale-emby-mapped-report-item`),
    )
    assert.equal(repeatDetail.status, 200)
    const repeatPayload = await repeatDetail.json()
    assert.equal(repeatPayload.Name, 'Mapped Report Song')

    const subtitle = await dispatchEmbyRequest(
      new Request(`http://local/emby${detailPayload.MediaSources[0].MediaStreams[1].DeliveryUrl}`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby${detailPayload.MediaSources[0].MediaStreams[1].DeliveryUrl}`),
    )
    assert.equal(subtitle.status, 200)
    assert.match(subtitle.headers.get('content-type') ?? '', /application\/json/)
    const subtitlePayload = await subtitle.json()
    assert.equal(subtitlePayload.TrackEvents[0].Text, '映射歌词')
    assert.equal(new URL(upstreamRequests[0]).pathname, '/Users/emby-user-999119/Items/stale-emby-mapped-report-item')
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999119')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('stale-emby-track.stale-emby-mapped-report-item')
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)
    db.prepare("DELETE FROM remote_mappings WHERE local_type = 'track' AND local_key = ? AND remote = 'emby'").run(`tx:${songmid}`)
    globalThis.fetch = originalFetch
  }
})

test('mapped Emby item detail returns upstream item when mapping is valid', async () => {
  const originalFetch = globalThis.fetch
  const songmid = `qq-valid-mapped-detail-${Date.now()}`
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999120')
    saveQQLoginCookie('uin=o999120; qm_keyst=test-key')
    markAccountUpstreamBound('999120')
    const account = getAccountByQQ('999120')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`
    const song: MusicInfo = {
      source: 'tx',
      songmid,
      name: 'Valid Mapped Song',
      singer: 'QQ Artist',
      albumName: 'QQ Album',
      interval: '03:08',
      types: [{ type: '320k', size: '1 MB' }],
    }
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({ song }))
    upsertRemoteMapping({
      localType: 'track',
      localKey: `tx:${songmid}`,
      remote: 'emby',
      remoteId: 'valid-emby-mapped-item',
      raw: song,
    })

    const upstreamRequests: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      upstreamRequests.push(requestUrl.pathname)
      if (requestUrl.pathname.endsWith('/Users/emby-user-999120/Items/valid-emby-mapped-item')) {
        return Response.json({
          Id: 'valid-emby-mapped-item',
          Name: 'Upstream Valid Song',
          HasLyrics: false,
          MediaSources: [{ Id: 'valid-emby-mapped-item', MediaStreams: [{ Type: 'Audio', Index: 0 }] }],
        })
      }
      return Response.json({ error: 'unexpected upstream request' }, { status: 500 })
    }) as typeof fetch

    const detail = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items/valid-emby-mapped-item`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items/valid-emby-mapped-item`),
    )
    assert.equal(detail.status, 200)
    assert.equal(detail.headers.get('x-x-music-source'), 'upstream')
    const payload = await detail.json()
    assert.equal(payload.Name, 'Upstream Valid Song')
    assert.equal(payload.HasLyrics, false)
    assert.deepEqual(upstreamRequests, ['/Users/emby-user-999120/Items/valid-emby-mapped-item'])
    assert.ok(db.prepare("SELECT id FROM remote_mappings WHERE local_type = 'track' AND local_key = ? AND remote = 'emby'").get(`tx:${songmid}`))
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999120')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('stale-emby-track.valid-emby-mapped-item')
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)
    db.prepare("DELETE FROM remote_mappings WHERE local_type = 'track' AND local_key = ? AND remote = 'emby'").run(`tx:${songmid}`)
    globalThis.fetch = originalFetch
  }
})

test('local emby virtual audio does not use local QQ cache as a playback source', async () => {
  const originalFetch = globalThis.fetch
  const originalLxMusicSourceScript = process.env.LX_MUSIC_SOURCE_SCRIPT
  const songmid = `qq-emby-master-mapped-${Date.now()}`
  const lowPath = join(process.cwd(), `data/test-${songmid}.mp3`)
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999049')
    process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/script/lxmusic?key=test-key'
    saveQQLoginCookie('uin=o999049; qm_keyst=test-key')
    markAccountUpstreamBound('999049')
    const account = getAccountByQQ('999049')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const songId = encodeVirtualId({ kind: 'qq-song', songmid })
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`
    const song: MusicInfo = {
      source: 'tx',
      songmid,
      name: 'Mapped Master Song',
      singer: 'QQ Artist',
      interval: '03:08',
      types: [{ type: 'flac', size: '49 MB' }, { type: '320k', size: '5 MB' }],
    }
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({ song }))
    upsertRemoteMapping({
      localType: 'track',
      localKey: `tx:${songmid}`,
      remote: 'emby',
      remoteId: 'emby-flac-master-item',
      raw: song,
    })
    mkdirSync(join(process.cwd(), 'data'), { recursive: true })
    writeFileSync(lowPath, 'low-local-bytes')
    const track = ensureTrack(song)
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: lowPath, sizeBytes: 9 })

    const requestedQualities: string[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'script.example') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { quality?: string }
        requestedQualities.push(body.quality ?? '')
        return Response.json({ url: 'https://cdn.example/audio.flac' })
      }
      if (requestUrl.hostname === 'cdn.example') return new Response('cdn-audio-bytes', { headers: { 'content-type': 'audio/flac' } })
      if (requestUrl.pathname.endsWith('/Items/emby-flac-master-item') && !requestUrl.pathname.includes('/Users/')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }
      if (requestUrl.pathname.endsWith('/Users/emby-user-999049/Items/emby-flac-master-item')) {
        return Response.json({
          Id: 'emby-flac-master-item',
          Container: 'flac',
          Size: 49_000_000,
          MediaSources: [{
            Container: 'flac',
            Size: 49_000_000,
            MediaStreams: [{ Type: 'Audio', Codec: 'flac', BitRate: 900_000 }],
          }],
        })
      }
      if (requestUrl.pathname.includes('/Audio/emby-flac-master-item/')) {
        return new Response('emby-master-bytes', { headers: { 'content-type': 'audio/flac' } })
      }
      if (requestUrl.hostname === 'stat6.y.qq.com') return new Response('{}')
      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Audio/${encodeURIComponent(songId)}/universal?Container=mp3&AudioCodec=mp3&api_key=${authPayload.AccessToken}`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Audio/${encodeURIComponent(songId)}/universal`),
    )
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), 'https://cdn.example/audio.flac')
    assert.deepEqual(requestedQualities, ['320k', 'flac'])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999049')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)
    db.prepare("DELETE FROM remote_mappings WHERE local_type = 'track' AND local_key = ? AND remote = 'emby'").run(`tx:${songmid}`)
    db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track' AND json_extract(payload_json, '$.songmid') = ?").run(songmid)
    rmSync(lowPath, { force: true })
    globalThis.fetch = originalFetch
    if (originalLxMusicSourceScript === undefined) {
      delete process.env.LX_MUSIC_SOURCE_SCRIPT
    } else {
      process.env.LX_MUSIC_SOURCE_SCRIPT = originalLxMusicSourceScript
    }
  }
})

test('local emby virtual audio falls back to WebDAV after LX sources fail', async () => {
  const originalFetch = globalThis.fetch
  const originalLxMusicSourceScript = process.env.LX_MUSIC_SOURCE_SCRIPT
  const songmid = `qq-webdav-playback-${Date.now()}`
  const finalPath = join(appConfig.musicDir, 'WebDAV Artist', 'WebDAV Album', 'WebDAV Artist - WebDAV Playback Song.flac')
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999052')
    process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/script/lxmusic?key=test-key'
    saveQQLoginCookie('uin=o999052; qm_keyst=test-key')
    markAccountUpstreamBound('999052')
    configureAccountUpstreamWebdav('999052')
    const account = getAccountByQQ('999052')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const songId = encodeVirtualId({ kind: 'qq-song', songmid })
    const song: MusicInfo = {
      source: 'tx',
      songmid,
      name: 'WebDAV Playback Song',
      singer: 'WebDAV Artist',
      albumName: 'WebDAV Album',
      interval: '03:08',
      types: [{ type: 'flac', size: '20 MB' }],
    }
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({ song }))
    mkdirSync(dirname(finalPath), { recursive: true })
    writeFileSync(finalPath, 'local-cache-should-not-be-read')
    const track = ensureTrack(song)
    upsertTrackFileStatus(track.id, 'flac', 'ready', { finalPath, sizeBytes: 31 })

    const webdavPaths: string[] = []
    const lxQualities: string[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'script.example') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { quality?: string }
        lxQualities.push(body.quality ?? '')
        return Response.json({ code: 500, message: '未获取到URL' })
      }
      if (requestUrl.hostname === 'webdav.example') {
        webdavPaths.push(requestUrl.pathname)
        assert.equal(new Headers(init?.headers).get('range'), 'bytes=0-')
        return new Response('webdav-audio-bytes', {
          status: 206,
          headers: {
            'content-type': 'audio/flac',
            'content-range': 'bytes 0-17/18',
            'content-length': '18',
          },
        })
      }
      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Audio/${encodeURIComponent(songId)}/universal?api_key=${authPayload.AccessToken}`, {
        headers: { range: 'bytes=0-' },
      }),
      stripOptionalEmbyPrefix(`/emby/Audio/${encodeURIComponent(songId)}/universal`),
    )
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('x-x-music-stream-mode'), 'webdav')
    assert.equal(await response.text(), 'webdav-audio-bytes')
    assert.deepEqual(lxQualities, ['flac', '320k', '128k'])
    assert.deepEqual(webdavPaths, ['/dav/music/WebDAV%20Artist/WebDAV%20Album/WebDAV%20Artist%20-%20WebDAV%20Playback%20Song.flac'])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999052')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM app_settings WHERE key LIKE ?").run(`music-url.unplayable.tx.${songmid}%`)
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)
    db.prepare("DELETE FROM jobs WHERE json_extract(payload_json, '$.songmid') = ?").run(songmid)
    rmSync(join(appConfig.musicDir, 'WebDAV Artist'), { recursive: true, force: true })
    globalThis.fetch = originalFetch
    if (originalLxMusicSourceScript === undefined) {
      delete process.env.LX_MUSIC_SOURCE_SCRIPT
    } else {
      process.env.LX_MUSIC_SOURCE_SCRIPT = originalLxMusicSourceScript
    }
  }
})

test('local emby virtual audio keeps low quality playback cache out of Emby until master is ready', async () => {
  const originalFetch = globalThis.fetch
  const originalLxMusicSourceScript = process.env.LX_MUSIC_SOURCE_SCRIPT
  const songmid = `qq-low-playback-master-${Date.now()}`
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999050')
    process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/script/lxmusic?key=test-key'
    saveQQLoginCookie('uin=o999050; qm_keyst=test-key')
    markAccountUpstreamBound('999050')
    const account = getAccountByQQ('999050')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const songId = encodeVirtualId({ kind: 'qq-song', songmid })
    const authHeader = `MediaBrowser Client="Musiver", Device="Mi-Mini-M2", Version="1.3.9", Token="${authPayload.AccessToken}"`
    const song: MusicInfo = {
      source: 'tx',
      songmid,
      name: 'Low Playback Master Song',
      singer: 'QQ Artist',
      interval: '03:08',
      types: [{ type: 'flac', size: '49 MB' }, { type: '320k', size: '5 MB' }],
    }
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({ song }))

    const requestedQualities: string[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'script.example') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { quality?: string }
        requestedQualities.push(body.quality ?? '')
        return Response.json({ url: `https://cdn.example/audio-${body.quality}.mp3` })
      }
      if (requestUrl.hostname === 'cdn.example') {
        return new Response(`audio-${requestUrl.pathname}`, { headers: { 'content-type': 'audio/mpeg' } })
      }
      if (requestUrl.hostname === 'stat6.y.qq.com') return new Response('{}')
      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/Audio/${encodeURIComponent(songId)}/stream?Container=mp3&AudioCodec=mp3&api_key=${authPayload.AccessToken}`, {
        headers: { authorization: authHeader, 'user-agent': 'musiver/1.3.9 (Macintosh)' },
      }),
      stripOptionalEmbyPrefix(`/Audio/${encodeURIComponent(songId)}/stream`),
    )
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), 'https://cdn.example/audio-320k.mp3')

    const immediateSyncJobs = db.prepare(`
      SELECT COUNT(*) AS count
      FROM jobs
      WHERE type = 'sync_emby_track'
        AND json_extract(payload_json, '$.songmid') = ?
    `).get(songmid) as { count: number }
    assert.equal(immediateSyncJobs.count, 0)

    assert.equal(requestedQualities[0], '320k')

    const syncJobs = db.prepare(`
      SELECT COUNT(*) AS count
      FROM jobs
      WHERE type = 'sync_emby_track'
        AND json_extract(payload_json, '$.songmid') = ?
    `).get(songmid) as { count: number }
    assert.equal(syncJobs.count, 0)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999050')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)
    db.prepare("DELETE FROM remote_mappings WHERE local_type = 'track' AND local_key = ? AND remote = 'emby'").run(`tx:${songmid}`)
    db.prepare("DELETE FROM jobs WHERE json_extract(payload_json, '$.songmid') = ?").run(songmid)
    globalThis.fetch = originalFetch
    if (originalLxMusicSourceScript === undefined) {
      delete process.env.LX_MUSIC_SOURCE_SCRIPT
    } else {
      process.env.LX_MUSIC_SOURCE_SCRIPT = originalLxMusicSourceScript
    }
  }
})

test('local emby virtual audio syncs best available fallback quality when requested flac is unavailable', async () => {
  const originalFetch = globalThis.fetch
  const originalLxMusicSourceScript = process.env.LX_MUSIC_SOURCE_SCRIPT
  const originalScanWaitMs = process.env.EMBY_SYNC_SCAN_WAIT_MS
  const songmid = `qq-flac-unavailable-${Date.now()}`
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999051')
    process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/script/lxmusic?key=test-key'
    process.env.EMBY_SYNC_SCAN_WAIT_MS = '0'
    saveQQLoginCookie('uin=o999051; qm_keyst=test-key')
    markAccountUpstreamBound('999051')
    const account = getAccountByQQ('999051')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const songId = encodeVirtualId({ kind: 'qq-song', songmid })
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`
    const song: MusicInfo = {
      source: 'tx',
      songmid,
      name: 'Flac Unavailable Song',
      singer: 'QQ Artist',
      interval: '03:08',
      types: [{ type: 'flac', size: '49 MB' }, { type: '320k', size: '5 MB' }],
    }
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({ song }))

    const requestedQualities: string[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'script.example') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { quality?: string }
        requestedQualities.push(body.quality ?? '')
        if (body.quality === 'flac') {
          return Response.json({ error: 'flac unavailable' }, { status: 404 })
        }
        return Response.json({ url: 'https://cdn.example/audio-320k.mp3' })
      }
      if (requestUrl.hostname === 'cdn.example') {
        return new Response('audio-320k', { headers: { 'content-type': 'audio/mpeg' } })
      }
      if (requestUrl.hostname === 'stat6.y.qq.com') return new Response('{}')
      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Audio/${encodeURIComponent(songId)}/universal?Container=opus%2Cwebm%7Copus%2Cmp3%2Caac%2Cflac&AudioCodec=aac&api_key=${authPayload.AccessToken}`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Audio/${encodeURIComponent(songId)}/universal`),
    )
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), 'https://cdn.example/audio-320k.mp3')
    assert.deepEqual(requestedQualities.slice(0, 2), ['flac', '320k'])

    const rows = db.prepare(`
      SELECT tf.quality, tf.status, tf.final_path AS finalPath, tf.raw_path AS rawPath, tf.error
      FROM track_files tf
      INNER JOIN tracks t ON t.id = tf.track_id
      WHERE t.source = 'tx' AND t.songmid = ?
      ORDER BY tf.quality
    `).all(songmid) as Array<{ quality: string; status: string; finalPath?: string | null; rawPath?: string | null; error?: string | null }>
    const flac = rows.find(row => row.quality === 'flac')
    const fallback = rows.find(row => row.quality === '320k')
    assert.equal(flac?.status, 'failed')
    assert.match(flac?.error ?? '', /404/)
    assert.equal(fallback?.status, 'failed')
    assert.equal(fallback?.error, 'Redirected to non-encrypted upstream without local cache')
    assert.equal(fallback?.finalPath ?? null, null)
    assert.equal(fallback?.rawPath ?? null, null)

    const tagOrSyncJobs = db.prepare(`
      SELECT COUNT(*) AS count
      FROM jobs
      WHERE type IN ('tag_track_file', 'sync_emby_track')
        AND json_extract(payload_json, '$.songmid') = ?
    `).get(songmid) as { count: number }
    assert.equal(tagOrSyncJobs.count, 0)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999051')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)
    db.prepare("DELETE FROM jobs WHERE json_extract(payload_json, '$.songmid') = ?").run(songmid)
    db.prepare("DELETE FROM remote_mappings WHERE local_type = 'track' AND local_key = ? AND remote = 'emby'").run(`tx:${songmid}`)
    globalThis.fetch = originalFetch
    if (originalLxMusicSourceScript === undefined) {
      delete process.env.LX_MUSIC_SOURCE_SCRIPT
    } else {
      process.env.LX_MUSIC_SOURCE_SCRIPT = originalLxMusicSourceScript
    }
    if (originalScanWaitMs === undefined) {
      delete process.env.EMBY_SYNC_SCAN_WAIT_MS
    } else {
      process.env.EMBY_SYNC_SCAN_WAIT_MS = originalScanWaitMs
    }
  }
})

test('local emby virtual audio passes through encrypted-extension preferred quality without LX ekey', async () => {
  const originalFetch = globalThis.fetch
  const originalLxMusicSourceScript = process.env.LX_MUSIC_SOURCE_SCRIPT
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999034')
    process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/script/lxmusic?key=test-key'
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
    const songmid = 'qq-encrypted-fallback-song-1'
    const songId = encodeVirtualId({ kind: 'qq-song', songmid })
    const authHeader = `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`

    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({
      song: {
        source: 'tx',
        songmid,
        name: 'QQ Encrypted Fallback Song',
        singer: 'QQ Artist',
        albumName: 'QQ Album',
        albumId: 'qq-album',
        interval: '03:08',
        types: [{ type: 'flac', size: '10 MB' }, { type: '320k', size: '4 MB' }],
        raw: { songId: 123, songType: 0, strMediaMid: 'qq-media-1' },
      },
    }))

    const requestedQualities: string[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'script.example') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { quality?: string }
        const quality = body.quality ?? 'flac'
        requestedQualities.push(quality)
        return Response.json({ url: `https://cdn.example/${quality === 'flac' ? 'audio.mflac' : 'audio.mp3'}` })
      }
      if (requestUrl.hostname === 'cdn.example' && requestUrl.pathname.endsWith('.mflac')) {
        return new Response('encrypted-bytes', { headers: { 'content-type': 'application/octet-stream' } })
      }
      if (requestUrl.hostname === 'cdn.example' && requestUrl.pathname.endsWith('.mp3')) {
        return new Response('fallback-audio', { headers: { 'content-type': 'audio/mpeg' } })
      }
      if (requestUrl.hostname === 'stat6.y.qq.com') return new Response('{}')
      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Audio/${encodeURIComponent(songId)}/universal?api_key=${authPayload.AccessToken}`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Audio/${encodeURIComponent(songId)}/universal`),
    )
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'encrypted-bytes')
    assert.deepEqual(requestedQualities, ['flac'])

    const statuses = db.prepare(`
      SELECT tf.quality, tf.status, tf.error, tf.final_path AS finalPath
      FROM track_files tf
      INNER JOIN tracks t ON t.id = tf.track_id
      WHERE t.source = 'tx' AND t.songmid = ?
      ORDER BY tf.quality
    `).all(songmid) as Array<{ quality: string; status: string; error?: string; finalPath?: string }>
    assert.ok(statuses.some(row => row.quality === 'flac' && row.status === 'streaming_and_caching'))
    assert.equal(statuses.some(row => row.quality === '320k'), false)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999034')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('virtual.song.qq-encrypted-fallback-song-1')
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run('qq-encrypted-fallback-song-1')
    db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track' AND json_extract(payload_json, '$.songmid') = ?").run('qq-encrypted-fallback-song-1')
    globalThis.fetch = originalFetch
    if (originalLxMusicSourceScript === undefined) {
      delete process.env.LX_MUSIC_SOURCE_SCRIPT
    } else {
      process.env.LX_MUSIC_SOURCE_SCRIPT = originalLxMusicSourceScript
    }
  }
})

test('local emby virtual audio passes through encrypted-extension upstreams without LX ekey when all qualities use them', async () => {
  const originalFetch = globalThis.fetch
  const originalLxMusicSourceScript = process.env.LX_MUSIC_SOURCE_SCRIPT
  const songmid = `qq-encrypted-requires-key-${Date.now()}`
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999035')
    process.env.LX_MUSIC_SOURCE_SCRIPT = 'https://script.example/script/lxmusic?key=test-key'
    saveQQLoginCookie('uin=o999035; qm_keyst=test-key')
    markAccountUpstreamBound('999035')
    const account = getAccountByQQ('999035')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const songId = encodeVirtualId({ kind: 'qq-song', songmid })
    const authHeader = `MediaBrowser Client="Amcfy Music for iOS", Version="1.0.20", Device="iPhone", Token="${authPayload.AccessToken}"`

    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({
      song: {
        source: 'tx',
        songmid,
        name: 'QQ Encrypted Requires Key Song',
        singer: 'QQ Artist',
        albumName: 'QQ Album',
        albumId: 'qq-album',
        interval: '03:08',
        types: [{ type: 'flac', size: '10 MB' }, { type: '320k', size: '4 MB' }, { type: '128k', size: '2 MB' }],
        raw: { songId: 123, songType: 0, strMediaMid: 'qq-media-key-required' },
      },
    }))

    const requestedQualities: string[] = []
    const downloadedAudioPaths: string[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'script.example') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { quality?: string }
        const quality = body.quality ?? 'flac'
        requestedQualities.push(quality)
        return Response.json({ url: `https://cdn.example/${quality === 'flac' ? 'audio.mflac' : `audio-${quality}.mgg`}` })
      }
      if (requestUrl.hostname === 'cdn.example' && (requestUrl.pathname.endsWith('.mflac') || requestUrl.pathname.endsWith('.mgg'))) {
        downloadedAudioPaths.push(requestUrl.pathname)
        return new Response('encrypted-bytes', { headers: { 'content-type': 'application/octet-stream' } })
      }
      if (requestUrl.hostname === 'stat6.y.qq.com') return new Response('{}')
      return Response.json({ Items: [], TotalRecordCount: 0 })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Audio/${encodeURIComponent(songId)}/universal?api_key=${authPayload.AccessToken}`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Audio/${encodeURIComponent(songId)}/universal`),
    )
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'encrypted-bytes')
    assert.deepEqual(requestedQualities, ['flac'])
    assert.deepEqual(downloadedAudioPaths, ['/audio.mflac'])

    const statuses = db.prepare(`
      SELECT tf.quality, tf.status, tf.error
      FROM track_files tf
      INNER JOIN tracks t ON t.id = tf.track_id
      WHERE t.source = 'tx' AND t.songmid = ?
      ORDER BY tf.quality
    `).all(songmid) as Array<{ quality: string; status: string; error?: string }>
    assert.ok(statuses.some(row => row.quality === 'flac' && row.status === 'streaming_and_caching' && !row.error))
    assert.equal(statuses.some(row => row.quality === '320k'), false)
    assert.equal(statuses.some(row => row.quality === '128k'), false)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999035')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM tracks WHERE songmid = ? AND source = 'tx'").run(songmid)
    db.prepare("DELETE FROM jobs WHERE type = 'sync_emby_track' AND json_extract(payload_json, '$.songmid') = ?").run(songmid)
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
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'img.example') imageRequests.push(String(url))
      if (requestUrl.pathname.endsWith('/Items')) return Response.json({ Items: [] })
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

test('local emby image requests prefer cached sidecar cover before QQ artwork', async () => {
  const originalFetch = globalThis.fetch
  const songmid = 'qq-sidecar-cover-song'
  const virtualId = encodeVirtualId({ kind: 'qq-song', songmid })
  const coverDir = join(process.cwd(), 'data/test-sidecar-cover-song')
  const audioPath = join(coverDir, 'test-sidecar-cover-song.mp3')
  const coverPath = join(coverDir, 'cover.jpg')
  try {
    const song: MusicInfo = {
      source: 'tx',
      songmid,
      name: 'QQ Sidecar Cover Song',
      singer: 'QQ Artist',
      albumName: 'QQ Album',
      albumId: 'qq-album',
      img: 'https://img.example/qq-sidecar-cover.jpg',
      interval: '03:00',
      types: [{ type: '320k', size: '1 MB' }],
    }
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(`virtual.song.${songmid}`, JSON.stringify({ song }))

    mkdirSync(coverDir, { recursive: true })
    writeFileSync(audioPath, 'audio-bytes')
    writeFileSync(coverPath, 'sidecar-cover-bytes')
    const track = ensureTrack(song)
    upsertTrackFileStatus(track.id, '320k', 'ready', { finalPath: audioPath, sizeBytes: 11, sha256: 'coversha' })

    const imageRequests: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      imageRequests.push(String(url))
      return new Response('qq-image-bytes', {
        headers: { 'content-type': 'image/png' },
      })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Items/${encodeURIComponent(virtualId)}/Images/Primary?maxWidth=480&maxHeight=480`),
      stripOptionalEmbyPrefix(`/emby/Items/${encodeURIComponent(virtualId)}/Images/Primary`),
    )

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/jpeg')
    assert.equal(await response.text(), 'sidecar-cover-bytes')
    assert.deepEqual(imageRequests, [])
  } finally {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
    rmSync(coverDir, { recursive: true, force: true })
    globalThis.fetch = originalFetch
  }
})

test('narjo virtual playlist and songmid image requests stay local when artwork is unavailable', async () => {
  const originalFetch = globalThis.fetch
  const songmid = '000jUWj52SiXUb'
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999116')
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
    saveQQLoginCookie('uin=o999116; qm_keyst=test-key')
    markAccountUpstreamBound('999116')
    const account = getAccountByQQ('999116')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()

    const song: MusicInfo = {
      source: 'tx',
      songmid,
      name: 'Narjo No Artwork Song',
      singer: 'QQ Artist',
      albumName: 'QQ Album',
      interval: '03:08',
      types: [{ type: '320k', size: '1 MB' }],
    }
    ensureTrack(song)

    globalThis.fetch = (async () => Response.json({ error: 'should not proxy upstream' }, { status: 500 })) as typeof fetch

    const playlistCover = await dispatchEmbyRequest(
      new Request(`http://local/Items/pl-${encodeURIComponent(encodeVirtualId({ kind: 'qq-daily' }))}/Images/Primary?api_key=${authPayload.AccessToken}`, {
        headers: { 'user-agent': 'Narjo/93' },
      }),
      stripOptionalEmbyPrefix(`/Items/pl-${encodeURIComponent(encodeVirtualId({ kind: 'qq-daily' }))}/Images/Primary`),
    )
    assert.equal(playlistCover.status, 204)
    assert.equal(playlistCover.headers.get('x-x-music-source'), 'local')

    const songmidCover = await dispatchEmbyRequest(
      new Request(`http://local/Items/${songmid}/Images/Primary?api_key=${authPayload.AccessToken}`, {
        headers: { 'user-agent': 'Narjo/93' },
      }),
      stripOptionalEmbyPrefix(`/Items/${songmid}/Images/Primary`),
    )
    assert.equal(songmidCover.status, 204)
    assert.equal(songmidCover.headers.get('x-x-music-source'), 'local')
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999116')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`virtual.song.${songmid}`)
    db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
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
      } else if (query.includes('IncludeItemTypes=MusicAlbum') && !query.includes('Filters=')) {
        assert.equal(payload.TotalRecordCount, 2)
        assert.deepEqual(payload.Items.map((item: { Name: string; Type: string }) => [item.Name, item.Type]), [
          ['QQ 每日推荐', 'MusicAlbum'],
          ['QQ 猜你喜欢', 'MusicAlbum'],
        ])
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

test('local emby root album list prepends QQ recommendation playlists after upstream response', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999118')
    saveQQLoginCookie('uin=o999118; qm_keyst=test-key')
    markAccountUpstreamBound('999118')
    const account = getAccountByQQ('999118')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="Amcfy Music for iOS", Version="1.0.20.5875", Device="iPhone", Token="${authPayload.AccessToken}"`

    const upstreamRequests: URL[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      upstreamRequests.push(requestUrl)
      return Response.json({
        Items: [{ Id: 'upstream-album-1', Name: 'Upstream Album', Type: 'MusicAlbum' }],
        TotalRecordCount: 1,
      })
    }) as typeof fetch

    const rootAlbums = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=MusicAlbum&ParentId=x-music-music&SortBy=Random&Limit=21&StartIndex=0`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(rootAlbums.status, 200)
    const rootAlbumsPayload = await rootAlbums.json()
    assert.equal(rootAlbumsPayload.TotalRecordCount, 3)
    assert.deepEqual(rootAlbumsPayload.Items.map((item: { Name: string; Type: string }) => [item.Name, item.Type]), [
      ['QQ 每日推荐', 'MusicAlbum'],
      ['QQ 猜你喜欢', 'MusicAlbum'],
      ['Upstream Album', 'MusicAlbum'],
    ])
    assert.equal(upstreamRequests[0].searchParams.get('Limit'), '19')

    const filteredAlbums = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=MusicAlbum&ParentId=x-music-music&Filters=IsFavorite&Limit=21&StartIndex=0`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(filteredAlbums.status, 200)
    const filteredAlbumsPayload = await filteredAlbums.json()
    assert.deepEqual(filteredAlbumsPayload, {
      Items: [{ Id: 'upstream-album-1', Name: 'Upstream Album', Type: 'MusicAlbum' }],
      TotalRecordCount: 1,
    })
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999118')
    clearUpstreamMusicLibraryCache()
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('local emby root library reads cached QQ favorites and playlists without upstream', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999117')
    saveQQLoginCookie('uin=o999117; euin=encrypted999117; qm_keyst=test-key')
    const account = getAccountByQQ('999117')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="Amcfy Music for iOS", Version="1.0.20.5875", Device="iPhone", Token="${authPayload.AccessToken}"`

    let favoriteRequests = 0
    let playlistRequests = 0
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com' && requestUrl.pathname.includes('/cgi-bin/musics.fcg')) {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
        assert.equal(body.req?.method, 'CgiGetDiss')
        favoriteRequests += 1
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              songlist: [{
                id: 123,
                mid: 'qq-root-song-1',
                title: 'Root Favorite Song',
                interval: 180,
                singer: [{ name: 'Root Artist', mid: 'root-artist-1' }],
                album: { name: 'Root Album', mid: 'root-album-1', time_public: '2025-01-02' },
                file: { media_mid: 'root-media-1', size_320mp3: 2048 },
              }],
              total_song_num: 1,
            },
          },
        })
      }

      if (requestUrl.hostname === 'c6.y.qq.com' && requestUrl.pathname.includes('/rsc/fcgi-bin/fcg_get_profile_homepage.fcg')) {
        playlistRequests += 1
        return Response.json({
          code: 0,
          data: {
            mydiss: {
              list: [{
                dissid: 'root-playlist-1',
                dissname: 'Root Playlist',
                song_cnt: 12,
                dir_create_time: '2025-02-03 04:05:06',
                creator: { name: 'Root User' },
                logo: 'https://y.qq.com/root-playlist.jpg',
              }],
            },
          },
        })
      }

      return Response.json({ error: 'unexpected request' }, { status: 500 })
    }) as typeof fetch

    const audioPath = `/emby/Users/${authPayload.User.Id}/Items`
    const audioQuery = 'StartIndex=0&Limit=21&SortBy=Random&SortOrder=Ascending&IncludeItemTypes=Audio&EnableImageTypes=Primary%2CBackdrop%2CThumb&Fields=BasicSyncInfo%2CProductionYear%2CThumb%2CPath&ImageTypeLimit=1&Recursive=true&ParentId=x-music-music'
    const [songs, cachedSongs] = await Promise.all([
      dispatchEmbyRequest(new Request(`http://local${audioPath}?${audioQuery}`, { headers: { 'X-Emby-Authorization': authHeader } }), stripOptionalEmbyPrefix(audioPath)),
      dispatchEmbyRequest(new Request(`http://local${audioPath}?${audioQuery}`, { headers: { 'X-Emby-Authorization': authHeader } }), stripOptionalEmbyPrefix(audioPath)),
    ])
    assert.equal(songs.status, 200)
    assert.equal(cachedSongs.status, 200)
    const songsPayload = await songs.json()
    const cachedSongsPayload = await cachedSongs.json()
    assert.equal(songsPayload.TotalRecordCount, 1)
    assert.equal(songsPayload.Items[0].Name, 'Root Favorite Song')
    assert.equal(songsPayload.Items[0].Type, 'Audio')
    assert.equal(songsPayload.Items[0].UserData.IsFavorite, true)
    assert.deepEqual(cachedSongsPayload, songsPayload)
    assert.equal(favoriteRequests, 1)

    const albumQuery = 'StartIndex=0&Limit=21&SortBy=Random&SortOrder=Ascending&IncludeItemTypes=MusicAlbum&Fields=PrimaryImageAspectRatio%2CChildCount%2CProductionYear&EnableImageTypes=Primary%2CThumb&ImageTypeLimit=1&Recursive=true&ParentId=x-music-music'
    const albums = await dispatchEmbyRequest(
      new Request(`http://local${audioPath}?${albumQuery}`, { headers: { 'X-Emby-Authorization': authHeader } }),
      stripOptionalEmbyPrefix(audioPath),
    )
    assert.equal(albums.status, 200)
    const albumsPayload = await albums.json()
    assert.equal(albumsPayload.TotalRecordCount, 3)
    assert.deepEqual(albumsPayload.Items.slice(0, 2).map((item: { Name: string; Type: string }) => [item.Name, item.Type]), [
      ['QQ 每日推荐', 'MusicAlbum'],
      ['QQ 猜你喜欢', 'MusicAlbum'],
    ])
    assert.ok(albumsPayload.Items.some((item: { Name: string; Type: string }) => item.Name === 'Root Playlist' && item.Type === 'MusicAlbum'))
    assert.ok(albumsPayload.Items.some((item: { Name: string; Type: string }) => item.Name === 'QQ 每日推荐' && item.Type === 'MusicAlbum'))

    const playlists = await dispatchEmbyRequest(
      new Request(`http://local${audioPath}?StartIndex=0&Limit=21&SortBy=SortName&IncludeItemTypes=Playlist&Recursive=true&ParentId=x-music-music`, { headers: { 'X-Emby-Authorization': authHeader } }),
      stripOptionalEmbyPrefix(audioPath),
    )
    assert.equal(playlists.status, 200)
    const playlistsPayload = await playlists.json()
    assert.equal(playlistsPayload.TotalRecordCount, 3)
    assert.deepEqual(playlistsPayload.Items.slice(0, 2).map((item: { Name: string; Type: string }) => [item.Name, item.Type]), [
      ['QQ 每日推荐', 'Playlist'],
      ['QQ 猜你喜欢', 'Playlist'],
    ])
    assert.ok(playlistsPayload.Items.some((item: { Name: string; Type: string }) => item.Name === 'Root Playlist' && item.Type === 'Playlist'))
    assert.equal(playlistRequests, 1)

    const mixed = await dispatchEmbyRequest(
      new Request(`http://local${audioPath}?StartIndex=0&Limit=10&SortBy=SortName&IncludeItemTypes=Audio%2CMusicAlbum&Recursive=true&ParentId=x-music-music`, { headers: { 'X-Emby-Authorization': authHeader } }),
      stripOptionalEmbyPrefix(audioPath),
    )
    assert.equal(mixed.status, 200)
    const mixedPayload = await mixed.json()
    assert.equal(mixedPayload.TotalRecordCount, 4)
    assert.ok(mixedPayload.Items.some((item: { Name: string; Type: string }) => item.Name === 'Root Favorite Song' && item.Type === 'Audio'))
    assert.ok(mixedPayload.Items.some((item: { Name: string; Type: string }) => item.Name === 'Root Playlist' && item.Type === 'MusicAlbum'))
    assert.equal(favoriteRequests, 1)
    assert.equal(playlistRequests, 1)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999117')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key IN ('virtual.song.qq-root-song-1', 'virtual.album.root-album-1', 'virtual.playlist.root-playlist-1')").run()
    globalThis.fetch = originalFetch
  }
})

test('local emby root audio defaults to created time descending without upstream sort params', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999121')
    saveQQLoginCookie('uin=o999121; euin=encrypted999121; qm_keyst=test-key')
    const account = getAccountByQQ('999121')
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
      if (requestUrl.hostname === 'u.y.qq.com' && requestUrl.pathname.includes('/cgi-bin/musics.fcg')) {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
        assert.equal(body.req?.method, 'CgiGetDiss')
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              songlist: [{
                id: 1201,
                mid: 'qq-default-sort-old',
                title: 'A Older Favorite',
                interval: 180,
                favoriteTime: '2025-01-01T00:00:00.000Z',
                singer: [{ name: 'Sort Artist', mid: 'sort-artist-1' }],
                album: { name: 'Sort Album', mid: 'sort-album-1', time_public: '2025-01-02' },
                file: { media_mid: 'sort-media-1', size_320mp3: 2048 },
              }, {
                id: 1202,
                mid: 'qq-default-sort-new',
                title: 'Z Newer Favorite',
                interval: 180,
                favoriteTime: '2025-02-01T00:00:00.000Z',
                singer: [{ name: 'Sort Artist', mid: 'sort-artist-1' }],
                album: { name: 'Sort Album', mid: 'sort-album-1', time_public: '2025-01-02' },
                file: { media_mid: 'sort-media-2', size_320mp3: 2048 },
              }],
              total_song_num: 2,
            },
          },
        })
      }

      return Response.json({ error: 'unexpected request' }, { status: 500 })
    }) as typeof fetch

    const audioPath = `/emby/Users/${authPayload.User.Id}/Items`
    const response = await dispatchEmbyRequest(
      new Request(`http://local${audioPath}?StartIndex=0&Limit=10&IncludeItemTypes=Audio&Recursive=true&ParentId=x-music-music`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(audioPath),
    )
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.TotalRecordCount, 2)
    assert.deepEqual(payload.Items.map((item: { Name: string }) => item.Name), [
      'Z Newer Favorite',
      'A Older Favorite',
    ])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999121')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key IN ('virtual.song.qq-default-sort-old', 'virtual.song.qq-default-sort-new')").run()
    globalThis.fetch = originalFetch
  }
})

test('local emby random root library order reshuffles cached QQ items per request', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999119')
    saveQQLoginCookie('uin=o999119; euin=encrypted999119; qm_keyst=test-key')
    const account = getAccountByQQ('999119')
    assert.ok(account)

    const auth = await handleLocalEmbyRequest(new Request('http://local/emby/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), stripOptionalEmbyPrefix('/emby/Users/AuthenticateByName'))
    assert.equal(auth?.status, 200)
    const authPayload = await auth!.json()
    const authHeader = `MediaBrowser Client="Amcfy Music for iOS", Version="1.0.20.5875", Device="iPhone", Token="${authPayload.AccessToken}"`

    let favoriteRequests = 0
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com' && requestUrl.pathname.includes('/cgi-bin/musics.fcg')) {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
        assert.equal(body.req?.method, 'CgiGetDiss')
        favoriteRequests += 1
        return Response.json({
          code: 0,
          req: {
            code: 0,
            data: {
              songlist: Array.from({ length: 12 }, (_, index) => ({
                id: 1000 + index,
                mid: `qq-random-song-${index}`,
                title: `Random Favorite Song ${index}`,
                interval: 180,
                singer: [{ name: 'Random Artist', mid: 'random-artist-1' }],
                album: { name: 'Random Album', mid: `random-album-${index}`, time_public: '2025-01-02' },
                file: { media_mid: `random-media-${index}`, size_320mp3: 2048 },
              })),
              total_song_num: 12,
            },
          },
        })
      }

      return Response.json({ error: 'unexpected request' }, { status: 500 })
    }) as typeof fetch

    const audioPath = `/emby/Users/${authPayload.User.Id}/Items`
    const audioQuery = 'StartIndex=0&Limit=12&SortBy=Random&SortOrder=Ascending&IncludeItemTypes=Audio&Recursive=true&ParentId=x-music-music'
    const orders: string[] = []
    for (let index = 0; index < 6; index += 1) {
      const response = await dispatchEmbyRequest(
        new Request(`http://local${audioPath}?${audioQuery}`, { headers: { 'X-Emby-Authorization': authHeader } }),
        stripOptionalEmbyPrefix(audioPath),
      )
      assert.equal(response.status, 200)
      const payload = await response.json()
      assert.equal(payload.TotalRecordCount, 12)
      orders.push(payload.Items.map((item: { Id: string }) => item.Id).join(','))
    }

    assert.ok(new Set(orders).size > 1)
    assert.equal(favoriteRequests, 1)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999119')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key LIKE 'virtual.song.qq-random-song-%'").run()
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
