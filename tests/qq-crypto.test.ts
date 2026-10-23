import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decryptQQMusicAg1Request,
  encryptQQMusicAg1Request,
  qqMusicGtk,
} from '@/lib/qq/crypto'

test('QQ Music AG-1 request encryption round trips the signed payload', () => {
  const iv = Buffer.from('00112233445566778899aabb', 'hex')
  const payload = {
    comm: { uin: 123456, g_tk: qqMusicGtk('test-key') },
    req_0: { module: 'music.musicasset.PlaylistDetailWrite', method: 'AddSonglist' },
  }
  const encrypted = encryptQQMusicAg1Request(payload, iv)
  const packet = Buffer.from(encrypted, 'base64')

  assert.deepEqual(packet.subarray(0, 12), iv)
  assert.deepEqual(JSON.parse(decryptQQMusicAg1Request(encrypted)), payload)
})

test('QQ Music g_tk uses the current hash33 seed', () => {
  assert.equal(qqMusicGtk('test-key'), 2094044315)
  assert.notEqual(qqMusicGtk('test-key'), qqMusicGtk('other-key'))
})
