import assert from 'node:assert/strict'
import test from 'node:test'
import { db } from '@/lib/db'
import { deleteSetting, getEffectiveSettings, getSetting, setSetting, updateEffectiveSettings } from '@/lib/db/settings'
import { getAccountByQQ } from '@/lib/db/accounts'
import { clearQQLoginCookie, saveQQLoginCookie } from '@/lib/db/qq-session'
import { dispatchEmbyRequest } from '@/lib/emby/dispatch'
import { handleLocalEmbyRequest } from '@/lib/emby/local-handlers'
import { normalizeEmbyPath, stripOptionalEmbyPrefix } from '@/lib/emby/paths'
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

test('local emby music library item list returns empty collection without upstream fallback', async () => {
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

    const items = await dispatchEmbyRequest(
      new Request(`http://local/emby/Users/${authPayload.User.Id}/Items?IncludeItemTypes=Audio&ParentId=mixmusic-music&SearchTerm=&Limit=500&StartIndex=0`, {
        headers: {
          'X-Emby-Authorization': `MediaBrowser Client="ampcast", Version="0.9.28", Device="PC", Token="${authPayload.AccessToken}"`,
        },
      }),
      stripOptionalEmbyPrefix(`/emby/Users/${authPayload.User.Id}/Items`),
    )
    assert.equal(items.status, 200)
    const payload = await items.json()
    assert.deepEqual(payload, { Items: [], TotalRecordCount: 0 })
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999003')
    clearQQLoginCookie()
  }
})

test('local emby library exploration endpoints return stable empty collections', async () => {
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
      assert.deepEqual(await response.json(), { Items: [], TotalRecordCount: 0 })
    }

    for (const query of [
      'IncludeItemTypes=Audio&Fields=AudioInfo%2CChildCount%2CDateCreated%2CGenres%2CMediaSources%2CParentIndexNumber%2CPath%2CProductionYear%2CPremiereDate%2COverview%2CPresentationUniqueKey%2CProviderIds%2CUserDataPlayCount%2CUserDataLastPlayedDate&EnableUserData=true&Recursive=true&ImageTypeLimit=1&EnableImageTypes=Primary&EnableTotalRecordCount=true&ParentId=mixmusic-music&Filters=IsPlayed&SortBy=PlayCount%2CDatePlayed&SortOrder=Descending&Limit=500&StartIndex=0',
      'IncludeItemTypes=Audio&Fields=AudioInfo%2CChildCount%2CDateCreated%2CGenres%2CMediaSources%2CParentIndexNumber%2CPath%2CProductionYear%2CPremiereDate%2COverview%2CPresentationUniqueKey%2CProviderIds%2CUserDataPlayCount%2CUserDataLastPlayedDate&EnableUserData=true&Recursive=true&ImageTypeLimit=1&EnableImageTypes=Primary&EnableTotalRecordCount=true&ParentId=mixmusic-music&Filters=IsFavorite&SortBy=AlbumArtist%2CAlbum%2CParentIndexNumber%2CIndexNumber%2CSortName&SortOrder=Ascending&Limit=500&StartIndex=0',
      'IncludeItemTypes=MusicAlbum&Fields=AudioInfo%2CChildCount%2CDateCreated%2CGenres%2CMediaSources%2CParentIndexNumber%2CPath%2CProductionYear%2CPremiereDate%2COverview%2CPresentationUniqueKey%2CProviderIds%2CUserDataPlayCount%2CUserDataLastPlayedDate&EnableUserData=true&Recursive=true&ImageTypeLimit=1&EnableImageTypes=Primary&EnableTotalRecordCount=true&ParentId=mixmusic-music&SortBy=DateCreated%2CSortName&SortOrder=Descending%2CAscending&Limit=500&StartIndex=0',
      'IncludeItemTypes=Audio&Fields=AudioInfo%2CChildCount%2CDateCreated%2CGenres%2CMediaSources%2CParentIndexNumber%2CPath%2CProductionYear%2CPremiereDate%2COverview%2CPresentationUniqueKey%2CProviderIds%2CUserDataPlayCount%2CUserDataLastPlayedDate&EnableUserData=true&Recursive=true&ImageTypeLimit=1&EnableImageTypes=Primary&EnableTotalRecordCount=true&ParentId=mixmusic-music&SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed&Limit=200&StartIndex=0',
      'IncludeItemTypes=Playlist&Fields=AudioInfo%2CChildCount%2CDateCreated%2CGenres%2CMediaSources%2CParentIndexNumber%2CPath%2CProductionYear%2CPremiereDate%2COverview%2CPresentationUniqueKey%2CProviderIds%2CUserDataPlayCount%2CUserDataLastPlayedDate&EnableUserData=true&Recursive=true&ImageTypeLimit=1&EnableImageTypes=Primary&EnableTotalRecordCount=true&ParentId=mixmusic-music&SortBy=SortName&SortOrder=Ascending&Limit=500&StartIndex=0',
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

    const image = await dispatchEmbyRequest(
      new Request('http://local/emby/Items/mixmusic-music/Images/Primary', { headers: { 'X-Emby-Authorization': authHeader } }),
      stripOptionalEmbyPrefix('/emby/Items/mixmusic-music/Images/Primary'),
    )
    assert.equal(image.status, 204)
  } finally {
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('999004')
    clearQQLoginCookie()
  }
})

test('virtual emby ids round-trip structured ids', () => {
  const id = encodeVirtualId({ kind: 'qq-song', songmid: 'abc', playlistId: 'list1' })
  assert.deepEqual(decodeVirtualId(id), { kind: 'qq-song', songmid: 'abc', playlistId: 'list1' })
})
