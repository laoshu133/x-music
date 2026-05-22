import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { appConfig } from '@/lib/config'

const databasePath = appConfig.databaseUrl.startsWith('file:')
  ? appConfig.databaseUrl.slice('file:'.length)
  : appConfig.databaseUrl

const resolvedDatabasePath = path.resolve(databasePath)
fs.mkdirSync(path.dirname(resolvedDatabasePath), { recursive: true })

const schemaPath = path.join(process.cwd(), 'src/lib/db/schema.sql')

export const db = withDatabaseInitLock(() => {
  const database = new Database(resolvedDatabasePath)
  database.pragma('busy_timeout = 5000')
  database.pragma('journal_mode = WAL')
  database.pragma('foreign_keys = ON')

  database.exec(fs.readFileSync(schemaPath, 'utf8'))

  for (const statement of [
    'ALTER TABLE track_files ADD COLUMN lyrics_path TEXT',
    'ALTER TABLE track_files ADD COLUMN cover_path TEXT',
    'ALTER TABLE track_files ADD COLUMN tagged_at TEXT',
    'ALTER TABLE accounts ADD COLUMN emby_user_id TEXT',
    'ALTER TABLE accounts ADD COLUMN emby_access_token TEXT',
    'ALTER TABLE accounts ADD COLUMN last_login_at TEXT',
    'ALTER TABLE accounts ADD COLUMN last_login_ip TEXT',
    'ALTER TABLE accounts ADD COLUMN last_active_at TEXT',
    'ALTER TABLE play_events ADD COLUMN qq_uin TEXT',
    'ALTER TABLE favorite_sync ADD COLUMN qq_uin TEXT',
    'ALTER TABLE resource_cache ADD COLUMN last_accessed_at TEXT',
  ]) {
    try {
      database.exec(statement)
    } catch (error) {
      if (!String(error).includes('duplicate column name')) throw error
    }
  }

  return database
})

function withDatabaseInitLock<T>(callback: () => T): T {
  const lockPath = `${resolvedDatabasePath}.init.lock`
  let lockFd: number | undefined
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      lockFd = fs.openSync(lockPath, 'wx')
      break
    } catch (error) {
      if (!isFileExistsError(error) || Date.now() >= deadline) throw error
      sleepSync(50)
    }
  }

  try {
    return callback()
  } finally {
    if (lockFd !== undefined) fs.closeSync(lockFd)
    fs.rmSync(lockPath, { force: true })
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isFileExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
}
