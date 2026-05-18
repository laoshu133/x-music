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
