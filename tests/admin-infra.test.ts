import assert from 'node:assert/strict'
import test from 'node:test'
import { db } from '@/lib/db'
import { deleteSetting, getEffectiveSettings, getSetting, setSetting, updateEffectiveSettings } from '@/lib/db/settings'
import { getAccountByQQ } from '@/lib/db/accounts'
import { clearQQLoginCookie, saveQQLoginCookie } from '@/lib/db/qq-session'
import { dispatchEmbyRequest } from '@/lib/emby/dispatch'
import { handleLocalEmbyRequest } from '@/lib/emby/local-handlers'
import { normalizeEmbyPath, stripOptionalEmbyPrefix } from '@/lib/emby/paths'
import { proxyToUpstreamEmby } from '@/lib/emby/upstream-proxy'
import { readEmbyAccessToken } from '@/lib/emby/tokens'
import { decodeVirtualId, encodeVirtualId } from '@/lib/emby/virtual-ids'

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
    assert.equal(account?.embyUsername, '123456')
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

test('emby path helpers normalize optional emby prefix', () => {
  assert.equal(stripOptionalEmbyPrefix('/emby/Items'), '/Items')
  assert.equal(stripOptionalEmbyPrefix('/Items'), '/Items')
  assert.equal(normalizeEmbyPath(['emby', 'System', 'Info', 'Public']), '/System/Info/Public')
})

test('local emby public info supports original emby routes', async () => {
  const response = await handleLocalEmbyRequest(new Request('http://local/System/Info/Public'), '/System/Info/Public')
  assert.equal(response?.status, 200)
  const payload = await response!.json()
  assert.equal(payload.ServerName, 'miXmusic')
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
    const account = getAccountByQQ('999001')
    assert.ok(account)

    const ok = await handleLocalEmbyRequest(new Request('http://local/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: account.embyUsername, Pw: account.embyPassword }),
    }), '/Users/AuthenticateByName')
    assert.equal(ok?.status, 200)
    const payload = await ok!.json()
    assert.equal(payload.User.Name, account.embyUsername)
    assert.equal(payload.ServerId, 'mixmusic')
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

test('local emby user views returns music library for ampcast startup', async () => {
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999002')
    saveQQLoginCookie('uin=o999002; qm_keyst=test-key')
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
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=mixmusic-music&SearchTerm=&Limit=500&StartIndex=0`, {
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
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('local emby search merges upstream Emby items with QQ virtual songs', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999005')
    saveQQLoginCookie('uin=o999005; qm_keyst=test-key')
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
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=mixmusic-music&SearchTerm=song&Limit=50&StartIndex=0`, {
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

test('local emby playlist search merges upstream and QQ playlists', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999006')
    saveQQLoginCookie('uin=o999006; qm_keyst=test-key')
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
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Playlist&ParentId=mixmusic-music&SearchTerm=playlist&Limit=10&StartIndex=0`, {
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

test('local emby favorites merge QQ songs and virtual albums', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999011')
    saveQQLoginCookie('uin=o999011; euin=encrypted999011; qm_keyst=test-key')
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
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=mixmusic-music&Filters=IsFavorite&Limit=500&StartIndex=0`, {
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
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=MusicAlbum&ParentId=mixmusic-music&Filters=IsFavorite&Limit=500&StartIndex=0`, {
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

test('local emby query parent id expands QQ virtual playlist items', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999008')
    saveQQLoginCookie('uin=o999008; qm_keyst=test-key')
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

test('local emby virtual song item details and audio HEAD stay local', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999009')
    saveQQLoginCookie('uin=o999009; qm_keyst=test-key')
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
    assert.equal(detailsPayload.Id, songId)

    const head = await dispatchEmbyRequest(
      new Request(`http://local/emby/Audio/${encodeURIComponent(songId)}/universal?api_key=${authPayload.AccessToken}`, {
        method: 'HEAD',
      }),
      stripOptionalEmbyPrefix(`/emby/Audio/${encodeURIComponent(songId)}/universal`),
    )
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-type'), 'audio/mpeg')
    assert.equal(head.headers.get('x-mixmusic-source'), 'upstream')
    assert.deepEqual(upstreamRequests, [])
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999009')
    clearQQLoginCookie()
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('virtual.song.qq-play-song-1')
    globalThis.fetch = originalFetch
  }
})

test('local emby virtual playback reports are consumed locally', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999010')
    saveQQLoginCookie('uin=o999010; qm_keyst=test-key')
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

    const response = await dispatchEmbyRequest(
      new Request(`http://local/emby/Items/${encodeURIComponent(virtualId)}/Images/Primary?maxWidth=480&maxHeight=480`),
      stripOptionalEmbyPrefix(`/emby/Items/${encodeURIComponent(virtualId)}/Images/Primary`),
    )

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.equal(await response.text(), 'qq-image-bytes')
    assert.deepEqual(imageRequests, ['https://img.example/qq-image.jpg'])
  } finally {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('virtual.song.qq-image-song')
    globalThis.fetch = originalFetch
  }
})

test('local emby library exploration endpoints proxy upstream and fall back to empty collections', async () => {
  const originalFetch = globalThis.fetch
  try {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999004')
    saveQQLoginCookie('uin=o999004; qm_keyst=test-key')
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
      `/emby/Albums`,
      `/emby/Genres?UserId=${authPayload.User.Id}&ParentId=mixmusic-music&IncludeItemTypes=MusicAlbum&SortBy=SortName&Recursive=true&Limit=500&StartIndex=0&EnableImages=false&EnableUserData=false&EnableTotalRecordCount=false`,
      `/emby/Years?UserId=${authPayload.User.Id}&ParentId=mixmusic-music&IncludeItemTypes=MusicAlbum&SortBy=SortName&Recursive=true&Limit=500&StartIndex=0&EnableImages=false&EnableUserData=false&EnableTotalRecordCount=false`,
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

    for (const query of [
      'IncludeItemTypes=Audio&Fields=AudioInfo%2CChildCount%2CDateCreated%2CGenres%2CMediaSources%2CParentIndexNumber%2CPath%2CProductionYear%2CPremiereDate%2COverview%2CPresentationUniqueKey%2CProviderIds%2CUserDataPlayCount%2CUserDataLastPlayedDate&EnableUserData=true&Recursive=true&ImageTypeLimit=1&EnableImageTypes=Primary&EnableTotalRecordCount=true&ParentId=mixmusic-music&Filters=IsPlayed&SortBy=PlayCount%2CDatePlayed&SortOrder=Descending&Limit=500&StartIndex=0',
      'IncludeItemTypes=Audio&Fields=AudioInfo%2CChildCount%2CDateCreated%2CGenres%2CMediaSources%2CParentIndexNumber%2CPath%2CProductionYear%2CPremiereDate%2COverview%2CPresentationUniqueKey%2CProviderIds%2CUserDataPlayCount%2CUserDataLastPlayedDate&EnableUserData=true&Recursive=true&ImageTypeLimit=1&EnableImageTypes=Primary&EnableTotalRecordCount=true&ParentId=mixmusic-music&Filters=IsFavorite&SortBy=AlbumArtist%2CAlbum%2CParentIndexNumber%2CIndexNumber%2CSortName&SortOrder=Ascending&Limit=500&StartIndex=0',
      'IncludeItemTypes=MusicAlbum&Fields=AudioInfo%2CChildCount%2CDateCreated%2CGenres%2CMediaSources%2CParentIndexNumber%2CPath%2CProductionYear%2CPremiereDate%2COverview%2CPresentationUniqueKey%2CProviderIds%2CUserDataPlayCount%2CUserDataLastPlayedDate&EnableUserData=true&Recursive=true&ImageTypeLimit=1&EnableImageTypes=Primary&EnableTotalRecordCount=true&ParentId=mixmusic-music&SortBy=DateCreated%2CSortName&SortOrder=Descending%2CAscending&Limit=500&StartIndex=0',
      'IncludeItemTypes=Audio&Fields=AudioInfo%2CChildCount%2CDateCreated%2CGenres%2CMediaSources%2CParentIndexNumber%2CPath%2CProductionYear%2CPremiereDate%2COverview%2CPresentationUniqueKey%2CProviderIds%2CUserDataPlayCount%2CUserDataLastPlayedDate&EnableUserData=true&Recursive=true&ImageTypeLimit=1&EnableImageTypes=Primary&EnableTotalRecordCount=true&ParentId=mixmusic-music&SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed&Limit=200&StartIndex=0',
      'IncludeItemTypes=Audio&Fields=AudioInfo%2CChildCount%2CDateCreated%2CGenres%2CMediaSources%2CParentIndexNumber%2CPath%2CProductionYear%2CPremiereDate%2COverview%2CPresentationUniqueKey%2CProviderIds%2CUserDataPlayCount%2CUserDataLastPlayedDate&EnableUserData=true&Recursive=true&ImageTypeLimit=1&EnableImageTypes=Primary&EnableTotalRecordCount=true&ParentId=mixmusic-music&SortBy=Random&Limit=100&StartIndex=0',
      'IncludeItemTypes=MusicAlbum&Fields=AudioInfo%2CChildCount%2CDateCreated%2CGenres%2CMediaSources%2CParentIndexNumber%2CPath%2CProductionYear%2CPremiereDate%2COverview%2CPresentationUniqueKey%2CProviderIds%2CUserDataPlayCount%2CUserDataLastPlayedDate&EnableUserData=true&Recursive=true&ImageTypeLimit=1&EnableImageTypes=Primary&EnableTotalRecordCount=true&ParentId=mixmusic-music&SortBy=Random&Limit=100&StartIndex=0',
    ]) {
      const response = await dispatchEmbyRequest(
        new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?${query}`, { headers: { 'X-Emby-Authorization': authHeader } }),
        stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
      )
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { Items: [], TotalRecordCount: 0 })
    }

    const playlists = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Playlist&Fields=AudioInfo%2CChildCount%2CDateCreated%2CGenres%2CMediaSources%2CParentIndexNumber%2CPath%2CProductionYear%2CPremiereDate%2COverview%2CPresentationUniqueKey%2CProviderIds%2CUserDataPlayCount%2CUserDataLastPlayedDate&EnableUserData=true&Recursive=true&ImageTypeLimit=1&EnableImageTypes=Primary&EnableTotalRecordCount=true&ParentId=mixmusic-music&SortBy=SortName&SortOrder=Ascending&Limit=500&StartIndex=0`, { headers: { 'X-Emby-Authorization': authHeader } }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(playlists.status, 200)
    const playlistsPayload = await playlists.json()
    assert.equal(playlistsPayload.TotalRecordCount, 2)
    assert.deepEqual(playlistsPayload.Items.map((item: { Name: string }) => item.Name).sort(), ['QQ 每日推荐', 'QQ 猜你喜欢'])

    const image = await dispatchEmbyRequest(
      new Request('http://local/emby/Items/mixmusic-music/Images/Primary', { headers: { 'X-Emby-Authorization': authHeader } }),
      stripOptionalEmbyPrefix('/emby/Items/mixmusic-music/Images/Primary'),
    )
    assert.equal(image.status, 204)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999004')
    clearQQLoginCookie()
    globalThis.fetch = originalFetch
  }
})

test('virtual emby ids round-trip structured ids', () => {
  const id = encodeVirtualId({ kind: 'qq-song', songmid: 'abc', playlistId: 'list1' })
  assert.deepEqual(decodeVirtualId(id), { kind: 'qq-song', songmid: 'abc', playlistId: 'list1' })
})
