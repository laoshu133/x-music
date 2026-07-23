import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { appConfig } from '@/lib/config'

const scryptN = 1 << 15
const scryptR = 8
const scryptP = 1
const keyLength = 32

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, keyLength, {
    N: scryptN,
    r: scryptR,
    p: scryptP,
    maxmem: 64 * 1024 * 1024,
  })
  return ['scrypt', scryptN, scryptR, scryptP, salt.toString('base64url'), hash.toString('base64url')].join('$')
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, n, r, p, saltText, hashText] = encoded.split('$')
  if (algorithm !== 'scrypt' || !saltText || !hashText) return false
  const expected = Buffer.from(hashText, 'base64url')
  const actual = crypto.scryptSync(password, Buffer.from(saltText, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  })
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

export function encryptSecret(value: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', instanceKey(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.')
}

export function decryptSecret(value: string): string {
  const [version, ivText, tagText, encryptedText] = value.split('.')
  if (version !== 'v1' || !ivText || !tagText || encryptedText === undefined) {
    throw new Error('Unsupported encrypted secret format')
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', instanceKey(), Buffer.from(ivText, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url')
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

let cachedInstanceKey: Buffer | undefined

function instanceKey(): Buffer {
  if (cachedInstanceKey) return cachedInstanceKey
  const configured = process.env.X_MUSIC_SECRET?.trim()
  if (configured) {
    cachedInstanceKey = crypto.createHash('sha256').update(configured).digest()
    return cachedInstanceKey
  }

  fs.mkdirSync(appConfig.dataDir, { recursive: true })
  const secretPath = path.join(appConfig.dataDir, '.x-music-secret')
  let secret: Buffer
  if (fs.existsSync(secretPath)) {
    secret = Buffer.from(fs.readFileSync(secretPath, 'utf8').trim(), 'base64url')
  } else {
    secret = crypto.randomBytes(32)
    fs.writeFileSync(secretPath, secret.toString('base64url'), { mode: 0o600 })
  }
  if (secret.length !== 32) throw new Error('Invalid XMusic instance secret')
  cachedInstanceKey = secret
  return secret
}
