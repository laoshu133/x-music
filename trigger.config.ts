import { defineConfig } from '@trigger.dev/sdk/v3'

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? 'x-music',
  dirs: ['./src/trigger'],
  runtime: 'node-22',
  tsconfig: './tsconfig.json',
  maxDuration: 600,
  retries: {
    default: {
      maxAttempts: Number(process.env.WORKER_MAX_ATTEMPTS ?? 3),
      factor: 2,
      minTimeoutInMs: 30_000,
      maxTimeoutInMs: 180_000,
      randomize: false,
    },
  },
  build: {
    external: ['better-sqlite3', 'node-id3'],
  },
})
