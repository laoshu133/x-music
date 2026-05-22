import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '@/lib/db'
import { deleteSetting, getEffectiveSettings, getSetting, setSetting, updateEffectiveSettings } from '@/lib/db/settings'
import { getAccountByQQ } from '@/lib/db/accounts'
import { clearQQLoginCookie, saveQQLoginCookie } from '@/lib/db/qq-session'
import { dispatchEmbyRequest } from '@/lib/emby/dispatch'
import { ensureUpstreamEmbyUserForAccount } from '@/lib/emby/auth'
import { handleLocalEmbyRequest } from '@/lib/emby/local-handlers'
import { normalizeEmbyPath, stripOptionalEmbyPrefix } from '@/lib/emby/paths'
import { proxyToUpstreamEmby } from '@/lib/emby/upstream-proxy'
import { readEmbyAccessToken } from '@/lib/emby/tokens'
import { decodeVirtualId, encodeVirtualId, songVirtualId } from '@/lib/emby/virtual-ids'
import { updateAccountEmbyPassword } from '@/lib/db/accounts'

function markAccountUpstreamBound(qqUin: string, embyUserId = `emby-user-${qqUin}`): void {
  db.prepare('UPDATE accounts SET emby_user_id = ? WHERE qq_uin = ?').run(embyUserId, qqUin)
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

      return Response.json({ error: 'unexpected request' }, { status: 500 })
    }) as typeof fetch

    const updated = await ensureUpstreamEmbyUserForAccount(account)
    assert.equal(updated.embyUserId, 'emby-user-999019')
    assert.equal(getAccountByQQ('999019')?.embyUserId, 'emby-user-999019')

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

      return Response.json({ error: 'unexpected request' }, { status: 500 })
    }) as typeof fetch

    await ensureUpstreamEmbyUserForAccount(account)

    const policy = requests.find(request => request.url.pathname.endsWith('/Users/emby-user-999021/Policy'))?.body
    assert.ok(policy)
    assert.equal(policy.EnableAllFolders, false)
    assert.deepEqual(policy.EnabledFolders, ['music-library-guid', '11696830'])
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

test('emby token parser accepts ampcast authorization header', () => {
  const request = new Request('http://local/emby/System/Endpoint', {
    headers: {
      'X-Emby-Authorization': 'MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="abc123"',
    },
  })
  assert.equal(readEmbyAccessToken(request), 'abc123')
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
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url))
      if (requestUrl.hostname === 'u.y.qq.com') {
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
      return Response.json({
        Items: [
          { Id: 'emby-folder-1', Name: 'Emby Folder', Type: 'CollectionFolder' },
          { Id: 'emby-song-1', Name: 'Emby Song', Type: 'Audio', Artists: ['Emby Artist'] },
        ],
        TotalRecordCount: 2,
      })
    }) as typeof fetch

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=x-music-music&SearchTerm=song&Limit=50&StartIndex=0`, {
        headers: {
          'X-Emby-Authorization': `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`,
        },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )

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

test('local emby search pages QQ songs with safe upstream page size', async () => {
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
    assert.equal(payload.Items.length, 250)
    assert.deepEqual(qqPageSizes, [50, 50, 50, 50, 50])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999016')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key LIKE 'virtual.song.qq-search-page-%'").run()
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

test('local emby playlist search pages QQ playlists with safe upstream page size', async () => {
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
    assert.equal(payload.Items.length, 120)
    assert.deepEqual(qqPageSizes, ['0:50', '1:50', '2:50'])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999017')
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('local emby favorites merge QQ songs and virtual albums', async () => {
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
                mid: 'qq-favorite-song-1',
                title: 'QQ Favorite Song',
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

      return Response.json({
        Items: [],
        TotalRecordCount: 0,
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
    assert.equal(albumsPayload.Items[0].Name, 'QQ Favorite Album')
    assert.equal(decodeVirtualId(albumsPayload.Items[0].Id)?.kind, 'qq-album')

    const albumSongs = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=${encodeURIComponent(albumsPayload.Items[0].Id)}&Limit=500&StartIndex=0`, {
        headers: { 'X-Emby-Authorization': authHeader },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(albumSongs.status, 200)
    const albumSongsPayload = await albumSongs.json()
    assert.equal(albumSongsPayload.TotalRecordCount, 1)
    assert.equal(albumSongsPayload.Items[0].Name, 'QQ Favorite Song')
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
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999012')
    clearQQLoginCookie()
    db.prepare("DELETE FROM app_settings WHERE key LIKE 'virtual.song.qq-favorite-page-%'").run()
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
      if (requestUrl.hostname === 'u.y.qq.com') {
        return Response.json({
          code: 0,
          toplist: {
            code: 0,
            data: {
              songInfoList: [{
                id: 123,
                mid: 'qq-daily-song-1',
                title: 'QQ Daily Song',
                interval: 188,
                singer: [{ name: 'QQ Artist', mid: 'qq-artist-1' }],
                album: { name: 'QQ Album', mid: 'qq-album-1' },
                file: { media_mid: 'qq-media-1', size_320mp3: 1024 },
              }],
              totalNum: 1,
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
    const dailyId = encodeVirtualId({ kind: 'qq-daily' })

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
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio%2CMusicVideo&ParentId=${encodeURIComponent(dailyId)}&Limit=250&StartIndex=0`, {
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

    const cached = await dispatchEmbyRequest(
      new Request(`http://local/emby/Items/${encodeURIComponent(virtualId)}/Images/Primary?maxWidth=480&maxHeight=480`),
      stripOptionalEmbyPrefix(`/emby/Items/${encodeURIComponent(virtualId)}/Images/Primary`),
    )
    assert.equal(cached.status, 200)
    assert.equal(await cached.text(), 'qq-image-bytes')
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
    assert.deepEqual(playlistsPayload.Items.map((item: { Name: string }) => item.Name).sort(), ['QQ 每日推荐', 'QQ 猜你喜欢'])

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
