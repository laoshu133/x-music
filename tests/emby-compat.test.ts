import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractSubtitleItemId,
  isFavoriteItemMutation,
  isAudioRequest,
  isItemsDeleteRequest,
  isLyricsRequest,
  isSubsonicGetSongRequest,
  isSubsonicLyricsRequest,
  isSubtitleStreamRequest,
} from '@/lib/emby/local-route-patterns'
import { readClientAccessToken } from '@/lib/emby/client-compat'

test('emby subtitle stream compatibility accepts long and short item paths', () => {
  const itemId = 'mix_virtual_song'
  const paths = [
    `/Items/${itemId}/${itemId}/Subtitles/1/Stream.lrc`,
    `/Items/${itemId}/Subtitles/2/Stream.js`,
    `/Videos/${itemId}/${itemId}/Subtitles/1/Stream.srt`,
    `/Videos/${itemId}/Subtitles/2/Stream.vtt`,
  ]

  for (const path of paths) {
    assert.equal(isSubtitleStreamRequest(path), true)
    assert.equal(extractSubtitleItemId(path), itemId)
  }
})

test('emby client compatibility reads access token from common headers and query keys', () => {
  assert.equal(
    readClientAccessToken(new Request('http://local/Items/1', {
      headers: { 'X-Emby-Token': 'header-token' },
    })),
    'header-token',
  )
  assert.equal(
    readClientAccessToken(new Request('http://local/Items/1?X-Emby-Token=query-token')),
    'query-token',
  )
  assert.equal(
    readClientAccessToken(new Request('http://local/Items/1?X-MediaBrowser-Token=media-token')),
    'media-token',
  )
  assert.equal(
    readClientAccessToken(new Request('http://local/Items/1', {
      headers: { Authorization: 'MediaBrowser Client="Amcfy", Token="auth-token"' },
    })),
    'auth-token',
  )
  assert.equal(
    readClientAccessToken(new Request('http://local/Users/Current?api_key=query-api-key')),
    'query-api-key',
  )
})

test('emby route compatibility accepts legacy and modern mutation endpoints', () => {
  assert.equal(isItemsDeleteRequest('POST', '/Items/Delete'), true)
  assert.equal(isItemsDeleteRequest('DELETE', '/Items/mix_virtual_song'), true)
  assert.equal(isItemsDeleteRequest('GET', '/Items/Delete'), false)

  assert.equal(isFavoriteItemMutation('POST', '/Users/user-1/FavoriteItems/mix_virtual_song'), true)
  assert.equal(isFavoriteItemMutation('POST', '/Users/user-1/FavoriteItems/mix_virtual_song/Delete'), true)
  assert.equal(isFavoriteItemMutation('DELETE', '/Users/user-1/FavoriteItems/mix_virtual_song'), true)
  assert.equal(isFavoriteItemMutation('GET', '/Users/user-1/FavoriteItems/mix_virtual_song'), false)
})

test('emby audio route compatibility accepts Narjo extension suffixes', () => {
  const itemId = 'mix_virtual_song'
  assert.equal(isAudioRequest(`/Audio/${itemId}/universal`), true)
  assert.equal(isAudioRequest(`/Audio/${itemId}/stream`), true)
  assert.equal(isAudioRequest(`/Audio/${itemId}/universal.flac`), true)
  assert.equal(isAudioRequest(`/Audio/${itemId}/stream.mp3`), true)
})

test('narjo lyric and subsonic compatibility paths are handled locally', () => {
  const itemId = 'mix_virtual_song'
  assert.equal(isLyricsRequest(`/Audio/${itemId}/Lyrics`), true)
  assert.equal(isLyricsRequest(`/Items/${itemId}/Lyrics`), true)
  assert.equal(isSubsonicLyricsRequest('/rest/getLyricsBySongId.view'), true)
  assert.equal(isSubsonicGetSongRequest('/rest/getSong.view'), true)
})
