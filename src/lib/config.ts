import path from 'node:path'
import { z } from 'zod'

const envSchema = z.object({
  LX_MUSIC_SOURCE_SCRIPT: z.string().url().optional(),
  DATABASE_URL: z.string().default('file:./data/app.sqlite'),
  MUSIC_DATA_DIR: z.string().default('./data'),
  EMBY_UPSTREAM_URL: z.string().url().optional(),
  EMBY_API_KEY: z.string().optional(),
  EMBY_PROXY_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
})

const env = envSchema.parse(process.env)

export const appConfig = {
  lxMusicSourceScript: env.LX_MUSIC_SOURCE_SCRIPT,
  databaseUrl: env.DATABASE_URL,
  dataDir: path.resolve(env.MUSIC_DATA_DIR),
  stagingDir: path.resolve(env.MUSIC_DATA_DIR, 'staging'),
  inboxDir: path.resolve(env.MUSIC_DATA_DIR, 'inbox'),
  musicDir: path.resolve(env.MUSIC_DATA_DIR, 'music'),
  embyUpstreamUrl: env.EMBY_UPSTREAM_URL,
  embyApiKey: env.EMBY_API_KEY,
  embyProxyTimeoutMs: env.EMBY_PROXY_TIMEOUT_MS,
} as const
