import path from 'node:path'
import { z } from 'zod'

const envSchema = z.object({
  LX_MUSIC_URL_SCRIPT: z.string().url().optional(),
  DATABASE_URL: z.string().default('file:./data/app.sqlite'),
  MUSIC_DATA_DIR: z.string().default('./data'),
})

const env = envSchema.parse(process.env)

export const appConfig = {
  lxMusicUrlScript: env.LX_MUSIC_URL_SCRIPT,
  databaseUrl: env.DATABASE_URL,
  dataDir: path.resolve(env.MUSIC_DATA_DIR),
  stagingDir: path.resolve(env.MUSIC_DATA_DIR, 'staging'),
  inboxDir: path.resolve(env.MUSIC_DATA_DIR, 'inbox'),
  musicDir: path.resolve(env.MUSIC_DATA_DIR, 'music'),
} as const
