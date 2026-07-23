import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { appConfig } from '@/lib/config'

const schemaVersion = 2
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

  database.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)

  const currentVersion = Number((database.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined)?.value ?? 0)
  if (currentVersion < schemaVersion && hasLegacyAccountSchema(database)) {
    backupBeforeBetaReset(database)
    resetLegacyUserData(database)
  }

  database.exec(fs.readFileSync(schemaPath, 'utf8'))
  applyPreservedTableMigrations(database)
  if (process.env.NODE_ENV === 'test') createLegacyTestView(database)
  database.prepare(`
    INSERT INTO app_meta (key, value, updated_at)
    VALUES ('schema_version', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(String(schemaVersion))

  return database
})

function hasLegacyAccountSchema(database: Database.Database): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'accounts'").get())
}

function backupBeforeBetaReset(database: Database.Database): void {
  if (process.env.NODE_ENV === 'test' || databasePath === ':memory:') return
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${resolvedDatabasePath}.pre-user-reset-${timestamp}.bak`
  database.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`)
}

function resetLegacyUserData(database: Database.Database): void {
  database.pragma('foreign_keys = OFF')
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'").get()) {
    database.prepare("DELETE FROM app_settings WHERE key LIKE 'emby.%'").run()
  }
  database.exec(`
    DROP TABLE IF EXISTS account_favorites;
    DROP TABLE IF EXISTS favorite_sync;
    DROP TABLE IF EXISTS play_events;
    DROP TABLE IF EXISTS remote_mappings;
    DROP TABLE IF EXISTS sync_events;
    DROP TABLE IF EXISTS jobs;
    DROP TABLE IF EXISTS qq_session;
    DROP TABLE IF EXISTS accounts;
    DROP TABLE IF EXISTS user_track_sync_requests;
    DROP TABLE IF EXISTS player_tokens;
    DROP TABLE IF EXISTS user_emby_profiles;
    DROP TABLE IF EXISTS qq_auth_attempts;
    DROP TABLE IF EXISTS qq_authorizations;
    DROP TABLE IF EXISTS user_sessions;
    DROP TABLE IF EXISTS users;
  `)
  database.pragma('foreign_keys = ON')
}

function applyPreservedTableMigrations(database: Database.Database): void {
  for (const statement of [
    'ALTER TABLE track_files ADD COLUMN lyrics_path TEXT',
    'ALTER TABLE track_files ADD COLUMN cover_path TEXT',
    'ALTER TABLE track_files ADD COLUMN tagged_at TEXT',
    'ALTER TABLE resource_cache ADD COLUMN last_accessed_at TEXT',
  ]) {
    try {
      database.exec(statement)
    } catch (error) {
      if (!String(error).includes('duplicate column name')) throw error
    }
  }
}

function createLegacyTestView(database: Database.Database): void {
  database.exec(`
    DROP VIEW IF EXISTS accounts;
    CREATE VIEW accounts AS
    SELECT
      q.qq_uin,
      q.qq_nickname,
      '' AS qq_cookie,
      q.encrypted_uin,
      q.qqmusic_key,
      q.auth_state AS qq_auth_state,
      q.auth_checked_at AS qq_auth_checked_at,
      q.auth_error AS qq_auth_error,
      e.upstream_user_id AS emby_user_id,
      u.username AS emby_username,
      '' AS emby_password,
      e.upstream_access_token AS emby_access_token,
      e.upstream_dsn AS emby_dsn,
      e.source_webdav_dsn AS emby_source_webdav_dsn,
      e.proxy_timeout_ms AS emby_proxy_timeout_ms,
      u.last_login_at,
      u.last_login_ip,
      u.last_active_at,
      u.created_at,
      u.updated_at
    FROM users u
    JOIN user_emby_profiles e ON e.user_id = u.id
    JOIN qq_authorizations q ON q.user_id = u.id;

    CREATE TRIGGER IF NOT EXISTS test_accounts_delete INSTEAD OF DELETE ON accounts
    BEGIN
      DELETE FROM users WHERE id = (SELECT user_id FROM qq_authorizations WHERE qq_uin = OLD.qq_uin);
    END;

    CREATE TRIGGER IF NOT EXISTS test_accounts_update INSTEAD OF UPDATE ON accounts
    BEGIN
      UPDATE users SET
        username = NEW.emby_username,
        last_login_at = NEW.last_login_at,
        last_login_ip = NEW.last_login_ip,
        last_active_at = NEW.last_active_at,
        updated_at = NEW.updated_at
      WHERE id = (SELECT user_id FROM qq_authorizations WHERE qq_uin = OLD.qq_uin);
      UPDATE qq_authorizations SET
        qq_nickname = NEW.qq_nickname,
        encrypted_uin = NEW.encrypted_uin,
        qqmusic_key = NEW.qqmusic_key,
        auth_state = NEW.qq_auth_state,
        auth_checked_at = NEW.qq_auth_checked_at,
        auth_error = NEW.qq_auth_error,
        updated_at = NEW.updated_at
      WHERE qq_uin = OLD.qq_uin;
      UPDATE user_emby_profiles SET
        upstream_user_id = NEW.emby_user_id,
        upstream_access_token = NEW.emby_access_token,
        upstream_dsn = NEW.emby_dsn,
        source_webdav_dsn = NEW.emby_source_webdav_dsn,
        proxy_timeout_ms = NEW.emby_proxy_timeout_ms
      WHERE user_id = (SELECT user_id FROM qq_authorizations WHERE qq_uin = OLD.qq_uin);
    END;

    DROP VIEW IF EXISTS account_favorites;
    CREATE VIEW account_favorites AS
      SELECT q.qq_uin, uf.track_id, uf.desired_state, uf.sync_state, uf.error, uf.created_at, uf.updated_at
      FROM user_favorites uf JOIN qq_authorizations q ON q.user_id = uf.user_id;
    CREATE TRIGGER IF NOT EXISTS test_account_favorites_delete INSTEAD OF DELETE ON account_favorites
    BEGIN
      DELETE FROM user_favorites
      WHERE user_id = (SELECT user_id FROM qq_authorizations WHERE qq_uin = OLD.qq_uin)
        AND track_id = OLD.track_id;
    END;
  `)
}

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
