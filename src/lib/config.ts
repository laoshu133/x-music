import path from 'node:path'
import { z } from 'zod'

const envSchema = z.object({
  LX_MUSIC_SOURCE_SCRIPT: z.string().url().optional(),
  DATABASE_URL: z.string().default('file:./data/app.sqlite'),
  MUSIC_DATA_DIR: z.string().default('./data'),
})

const env = envSchema.parse(process.env)

export const appConfig = {
  lxMusicSourceScript: env.LX_MUSIC_SOURCE_SCRIPT,
  databaseUrl: env.DATABASE_URL,
  dataDir: path.resolve(env.MUSIC_DATA_DIR),
  stagingDir: path.resolve(env.MUSIC_DATA_DIR, 'staging'),
  inboxDir: path.resolve(env.MUSIC_DATA_DIR, 'inbox'),
  musicDir: path.resolve(env.MUSIC_DATA_DIR, 'music'),
} as const
