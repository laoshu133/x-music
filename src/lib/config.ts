import path from 'node:path'
import fs from 'node:fs'
import { z } from 'zod'

loadDotEnv()

const defaultAmpcastUrl = 'http://ampcast:8000/'

const envSchema = z.object({
  LX_MUSIC_SOURCE_SCRIPT: z.string().url().optional(),
  DATABASE_URL: z.string().default('file:./data/app.sqlite'),
  MUSIC_DATA_DIR: z.string().default('./data'),
  EMBY_UPSTREAM_URL: z.string().url(),
  EMBY_API_KEY: z.string().min(1),
  EMBY_PROXY_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  EMBY_SOURCE_WEBDAV_DSN: z.string().url().optional(),
  ADMIN_QQ_UINS: z.string().default(''),
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
  get embyUpstreamUrl() {
    return currentEnv().EMBY_UPSTREAM_URL
  },
  get embyApiKey() {
    return currentEnv().EMBY_API_KEY
  },
  get embyProxyTimeoutMs() {
    return currentEnv().EMBY_PROXY_TIMEOUT_MS
  },
  get embySourceWebdavDsn() {
    return currentEnv().EMBY_SOURCE_WEBDAV_DSN
  },
  get ampcastUrl() {
    return defaultAmpcastUrl
  },
  get adminQQUins() {
    return parseAdminQQUins(currentEnv().ADMIN_QQ_UINS)
  },
} as const

function parseAdminQQUins(value: string): string[] {
  return value
    .split(/[,\s;]+/)
    .map(item => item.trim().replace(/^o/i, ''))
    .filter(Boolean)
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
