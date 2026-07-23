import path from 'node:path'
import fs from 'node:fs'
import { z } from 'zod'

loadDotEnv()

const defaultAmpcastUrl = 'http://ampcast:8000/'

const envSchema = z.object({
  LX_MUSIC_SOURCE_SCRIPT: z.string().url().optional(),
  LX_MUSIC_ID_LOOKUP_ENABLED: z.string().optional(),
  DATABASE_URL: z.string().default('file:./data/app.sqlite'),
  MUSIC_DATA_DIR: z.string().default('./data'),
  TRACK_CACHE_STAGING_TTL_HOURS: z.string().default('6'),
  TRACK_CACHE_INBOX_TTL_DAYS: z.string().default('7'),
  TRACK_CACHE_FAILED_TTL_DAYS: z.string().default('7'),
  TRACK_CACHE_MAX_BYTES: z.string().default(String(20 * 1024 * 1024 * 1024)),
  AMPCAST_URL: z.string().url().default(defaultAmpcastUrl),
})

const env = envSchema.parse(process.env)

const currentEnv = () => envSchema.parse(process.env)

export const appConfig = {
  databaseUrl: env.DATABASE_URL,
  dataDir: path.resolve(env.MUSIC_DATA_DIR),
  stagingDir: path.resolve(env.MUSIC_DATA_DIR, 'staging'),
  inboxDir: path.resolve(env.MUSIC_DATA_DIR, 'inbox'),
  musicDir: path.resolve(env.MUSIC_DATA_DIR, 'music'),
  toolsDir: path.resolve(env.MUSIC_DATA_DIR, 'tools'),
  get lxMusicSourceScript() {
    return currentEnv().LX_MUSIC_SOURCE_SCRIPT
  },
  get lxMusicIdLookupEnabled() {
    return currentEnv().LX_MUSIC_ID_LOOKUP_ENABLED === 'true'
  },
  get ampcastUrl() {
    return currentEnv().AMPCAST_URL
  },
  get trackCacheStagingTtlHours() {
    return parseNonNegativeNumber(currentEnv().TRACK_CACHE_STAGING_TTL_HOURS, 6)
  },
  get trackCacheInboxTtlDays() {
    return parseNonNegativeNumber(currentEnv().TRACK_CACHE_INBOX_TTL_DAYS, 7)
  },
  get trackCacheFailedTtlDays() {
    return parseNonNegativeNumber(currentEnv().TRACK_CACHE_FAILED_TTL_DAYS, 7)
  },
  get trackCacheMaxBytes() {
    return parseNonNegativeNumber(currentEnv().TRACK_CACHE_MAX_BYTES, 20 * 1024 * 1024 * 1024)
  },
} as const

function parseNonNegativeNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function loadDotEnv(): void {
  const filePath = path.resolve(process.cwd(), '.env')
  if (!fs.existsSync(filePath)) return
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const [rawKey, ...rawValueParts] = trimmed.split('=')
    const key = rawKey.trim()
    if (!key || process.env[key] !== undefined) continue
    let value = rawValueParts.join('=').trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}
