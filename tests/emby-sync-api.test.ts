import assert from 'node:assert/strict'
import test from 'node:test'
import { db } from '@/lib/db'
import { saveQQLoginCookie, clearQQLoginCookie } from '@/lib/db/qq-session'
import { getAccountByQQ } from '@/lib/db/accounts'
import { setLocalFavoriteSynced } from '@/lib/db/favorites'
import { ensureTrack, insertPlayEvent, listPlayHistory } from '@/lib/cache/store'
import { upsertRemoteMapping } from '@/lib/db/remote-mappings'
import { pullEmbyFavorites, pushLocalFavoritesToEmby, syncEmbyFavoritesFromQQList } from '@/lib/emby/favorites'
import { pullEmbyPlayHistory, pushLocalPlayHistoryToEmby } from '@/lib/emby/history'
import type { MusicInfo } from '@/lib/types'

const originalFetch = globalThis.fetch
const favoritePushSongmids = new Set<string>()
const historyPushSongmids = new Set<string>()

test.afterEach(() => {
  globalThis.fetch = originalFetch
  for (const songmid of favoritePushSongmids) cleanupSong(songmid)
  for (const songmid of historyPushSongmids) cleanupSong(songmid)
  favoritePushSongmids.clear()
  historyPushSongmids.clear()
  clearQQLoginCookie()
})

test('Emby favorite sync pulls mapped upstream favorites into local and QQ', async () => {
  const song = testSong('emby-favorite-sync-song')
  const requests: Array<{ url: URL; method: string; body?: string }> = []

  try {
    const account = prepareAccount('777001')
    upsertRemoteMapping({
      localType: 'track',
      localKey: `${song.source}:${song.songmid}`,
      remote: 'emby',
      remoteId: 'emby-fav-1',
      raw: song,
    })

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const request = new Request(url, init)
      requests.push({ url: new URL(request.url), method: request.method, body: init?.body ? String(init.body) : undefined })
      if (request.url.includes('/Users/emby-user-777001/Items')) {
        return Response.json({
          Items: [{ Id: 'emby-fav-1', UserData: { IsFavorite: true } }],
          TotalRecordCount: 1,
        })
      }
      return Response.json({ code: 0, req: { code: 0, data: { result: 0 } } })
    }) as typeof fetch

    const result = await pullEmbyFavorites({ account, limit: 50 })

    assert.equal(result.pulled, 1)
    assert.equal(result.qqSynced, 1)
    assert.ok(result.list.some(item => item.songmid === song.songmid))
    assert.ok(requests.some(request => request.url.pathname.endsWith('/Users/emby-user-777001/Items')))
    assert.ok(requests.some(request => request.url.pathname.endsWith('/cgi-bin/musics.fcg')))
  } finally {
    cleanupSong(song.songmid)
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('777001')
  }
})

test('Emby favorite sync pushes local mapped favorites upstream', async () => {
  const song = testSong('emby-favorite-push-song')
  const requests: Array<{ url: URL; method: string }> = []

  try {
    const account = prepareAccount('777002')
    favoritePushSongmids.add(song.songmid)
    setLocalFavoriteSynced(song, true, account.qqUin)
    upsertRemoteMapping({
      localType: 'track',
      localKey: `${song.source}:${song.songmid}`,
      remote: 'emby',
      remoteId: 'emby-fav-push-1',
      raw: song,
    })

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const request = new Request(url, init)
      requests.push({ url: new URL(request.url), method: request.method })
      return new Response(null, { status: 204 })
    }) as typeof fetch

    const result = await pushLocalFavoritesToEmby({ account, limit: 20 })

    assert.equal(result.synced, 1)
    assert.equal(requests[0].method, 'POST')
    assert.ok(requests[0].url.pathname.endsWith('/Users/emby-user-777002/FavoriteItems/emby-fav-push-1'))
  } finally {
    cleanupSong(song.songmid)
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('777002')
  }
})

test('Emby favorite sync aligns mapped Emby songs from QQ favorite list only', async () => {
  const favoriteSong = testSong('emby-qq-favorite-state-song')
  const absentSong = testSong('emby-qq-absent-state-song')
  const requests: Array<{ url: URL; method: string }> = []

  try {
    const account = prepareAccount('777005')
    upsertRemoteMapping({
      localType: 'track',
      localKey: `${favoriteSong.source}:${favoriteSong.songmid}`,
      remote: 'emby',
      remoteId: 'emby-not-favorited-yet',
      raw: favoriteSong,
    })
    upsertRemoteMapping({
      localType: 'track',
      localKey: `${absentSong.source}:${absentSong.songmid}`,
      remote: 'emby',
      remoteId: 'emby-not-on-qq-page',
      raw: absentSong,
    })

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const request = new Request(url, init)
      requests.push({ url: new URL(request.url), method: request.method })
      if (request.url.includes('/Users/emby-user-777005/Items')) {
        return Response.json({
          Items: [{ Id: 'already-favorite', UserData: { IsFavorite: true } }],
          TotalRecordCount: 1,
        })
      }
      return new Response(null, { status: 204 })
    }) as typeof fetch

    const result = await syncEmbyFavoritesFromQQList({
      account,
      qqFavorites: [favoriteSong],
      limit: 20,
    })

    assert.equal(result.attempted, 1)
    assert.equal(result.synced, 1)
    assert.equal(requests.filter(request => request.method === 'POST').length, 1)
    assert.ok(requests.some(request => request.url.pathname.endsWith('/Users/emby-user-777005/FavoriteItems/emby-not-favorited-yet')))
    assert.ok(!requests.some(request => request.url.pathname.includes('emby-not-on-qq-page')))
  } finally {
    cleanupSong(favoriteSong.songmid)
    cleanupSong(absentSong.songmid)
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('777005')
  }
})

test('Emby play history sync pulls mapped played items into local history', async () => {
  const song = testSong('emby-history-pull-song')
  const playedAt = '2026-05-24T09:10:11.000Z'

  try {
    const account = prepareAccount('777003')
    upsertRemoteMapping({
      localType: 'track',
      localKey: `${song.source}:${song.songmid}`,
      remote: 'emby',
      remoteId: 'emby-played-1',
      raw: song,
    })

    globalThis.fetch = (async (url: string | URL | Request) => {
      const request = new Request(url)
      if (request.url.includes('/Users/emby-user-777003/Items')) {
        return Response.json({
          Items: [{ Id: 'emby-played-1', UserData: { Played: true, PlayCount: 2, LastPlayedDate: playedAt } }],
          TotalRecordCount: 1,
        })
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    }) as typeof fetch

    const result = await pullEmbyPlayHistory({ account, limit: 20, syncQQ: false })
    const history = listPlayHistory(20).filter(item => item.songmid === song.songmid)

    assert.equal(result.pulled, 1)
    assert.equal(result.qqSynced, 0)
    assert.equal(history.length, 1)
    assert.equal(history[0].playedAt, playedAt)
  } finally {
    cleanupSong(song.songmid)
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('777003')
  }
})

test('Emby play history sync pushes local mapped plays upstream', async () => {
  const song = testSong('emby-history-push-song')
  const requests: Array<{ url: URL; method: string }> = []

  try {
    const account = prepareAccount('777004')
    historyPushSongmids.add(song.songmid)
    const track = ensureTrack(song)
    insertPlayEvent(track.id, '320k', account.qqUin, '2026-05-24T10:00:00.000Z')
    upsertRemoteMapping({
      localType: 'track',
      localKey: `${song.source}:${song.songmid}`,
      remote: 'emby',
      remoteId: 'emby-played-push-1',
      raw: song,
    })

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const request = new Request(url, init)
      requests.push({ url: new URL(request.url), method: request.method })
      return new Response(null, { status: 204 })
    }) as typeof fetch

    const result = await pushLocalPlayHistoryToEmby({ account, limit: 20 })

    assert.equal(result.synced, 1)
    assert.equal(requests[0].method, 'POST')
    assert.ok(requests[0].url.pathname.endsWith('/Users/emby-user-777004/PlayedItems/emby-played-push-1'))
    assert.equal(requests[0].url.searchParams.get('DatePlayed'), '2026-05-24T10:00:00.000Z')
  } finally {
    cleanupSong(song.songmid)
    db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run('777004')
  }
})

function prepareAccount(qqUin: string) {
  db.prepare('DELETE FROM accounts WHERE qq_uin = ?').run(qqUin)
  saveQQLoginCookie(`uin=o${qqUin}; euin=encrypted-${qqUin}; qm_keyst=test-key`)
  db.prepare('UPDATE accounts SET emby_user_id = ?, emby_access_token = ? WHERE qq_uin = ?')
    .run(`emby-user-${qqUin}`, `emby-token-${qqUin}`, qqUin)
  const account = getAccountByQQ(qqUin)
  assert.ok(account)
  return account
}

function testSong(songmid: string): MusicInfo {
  return {
    source: 'tx',
    songmid,
    name: `Song ${songmid}`,
    singer: 'Sync Tester',
    albumName: 'Sync Album',
    raw: {
      source: 'tx',
      songmid,
      name: `Song ${songmid}`,
      singer: 'Sync Tester',
      songId: Math.floor(Math.random() * 1_000_000) + 1,
      songType: 0,
    },
  }
}

function cleanupSong(songmid: string): void {
  db.prepare("DELETE FROM tracks WHERE source = 'tx' AND songmid = ?").run(songmid)
  db.prepare("DELETE FROM remote_mappings WHERE local_type = 'track' AND local_key = ?").run(`tx:${songmid}`)
}
