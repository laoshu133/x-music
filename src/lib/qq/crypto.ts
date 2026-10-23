import crypto from 'node:crypto'

const PART_1_INDEXES = [23, 14, 6, 36, 16, 40, 7, 19] as const
const PART_2_INDEXES = [16, 1, 32, 12, 19, 27, 8, 5] as const
const AG1_REQUEST_KEY = Buffer.from('bd305f10d0ff74b6ef54dab835b5e1cf', 'hex')
const AG1_RESPONSE_KEY = Buffer.from('7a3f8c1d5e9b2f0a6c4d7e8b1f3a5c9d0e2b6f4a81', 'hex')
const AG1_IV_LENGTH = 12
const AG1_TAG_LENGTH = 16
const SCRAMBLE_VALUES = [
  89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133,
  143, 161, 121, 179,
] as const

function pickHashByIndex(hash: string, indexes: readonly number[]) {
  return indexes.map((index) => hash[index]).join('')
}

function base64Encode(data: number[]) {
  return Buffer.from(data)
    .toString('base64')
    .replace(/[\\/+=]/g, '')
}

export function zzcSign(text: string) {
  const hash = crypto.createHash('sha1').update(text).digest('hex')
  const part1 = pickHashByIndex(hash, PART_1_INDEXES)
  const part2 = pickHashByIndex(hash, PART_2_INDEXES)
  const part3 = SCRAMBLE_VALUES.map((value, index) => {
    return value ^ Number.parseInt(hash.slice(index * 2, index * 2 + 2), 16)
  })
  return `zzc${part1}${base64Encode(part3)}${part2}`.toLowerCase()
}

export function hash33(value: string, seed = 0) {
  let hash = seed
  for (const character of value) {
    hash = (hash << 5) + hash + character.codePointAt(0)!
  }
  return hash & 0x7fffffff
}

export function qqMusicGtk(musickey: string) {
  return hash33(musickey, 5381)
}

export function encryptQQMusicAg1Request(payload: unknown, iv?: Buffer) {
  const ivBuffer = iv ?? crypto.randomBytes(AG1_IV_LENGTH)
  if (ivBuffer.length !== AG1_IV_LENGTH) {
    throw new Error(`QQ Music AG-1 IV must be ${AG1_IV_LENGTH} bytes`)
  }
  const plaintext = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')
  const cipher = crypto.createCipheriv('aes-128-gcm', AG1_REQUEST_KEY, ivBuffer, {
    authTagLength: AG1_TAG_LENGTH,
  })
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([ivBuffer, ciphertext, cipher.getAuthTag()]).toString('base64')
}

export function decryptQQMusicAg1Request(encoded: string) {
  const packet = Buffer.from(encoded, 'base64')
  if (packet.length <= AG1_IV_LENGTH + AG1_TAG_LENGTH) {
    throw new Error('QQ Music AG-1 request packet is too short')
  }
  const iv = packet.subarray(0, AG1_IV_LENGTH)
  const tag = packet.subarray(packet.length - AG1_TAG_LENGTH)
  const ciphertext = packet.subarray(AG1_IV_LENGTH, packet.length - AG1_TAG_LENGTH)
  const decipher = crypto.createDecipheriv('aes-128-gcm', AG1_REQUEST_KEY, iv, {
    authTagLength: AG1_TAG_LENGTH,
  })
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

export function decryptQQMusicAg1Response(input: string | Uint8Array) {
  const packet = typeof input === 'string' ? Buffer.from(input, 'base64') : Buffer.from(input)
  const plaintext = Buffer.allocUnsafe(packet.length)
  for (let index = 0; index < packet.length; index += 1) {
    plaintext[index] = packet[index]! ^ AG1_RESPONSE_KEY[index % AG1_RESPONSE_KEY.length]!
  }
  return plaintext.toString('utf8')
}
