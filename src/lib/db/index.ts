import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { appConfig } from '@/lib/config'

const databasePath = appConfig.databaseUrl.startsWith('file:')
  ? appConfig.databaseUrl.slice('file:'.length)
  : appConfig.databaseUrl

const resolvedDatabasePath = path.resolve(databasePath)
fs.mkdirSync(path.dirname(resolvedDatabasePath), { recursive: true })

export const db = new Database(resolvedDatabasePath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

const schemaPath = path.join(process.cwd(), 'src/lib/db/schema.sql')
db.exec(fs.readFileSync(schemaPath, 'utf8'))

for (const statement of [
  'ALTER TABLE track_files ADD COLUMN lyrics_path TEXT',
  'ALTER TABLE track_files ADD COLUMN cover_path TEXT',
  'ALTER TABLE track_files ADD COLUMN tagged_at TEXT',
  'ALTER TABLE accounts ADD COLUMN emby_user_id TEXT',
  'ALTER TABLE accounts ADD COLUMN emby_access_token TEXT',
]) {
  try {
    db.exec(statement)
  } catch (error) {
    if (!String(error).includes('duplicate column name')) throw error
  }
}
