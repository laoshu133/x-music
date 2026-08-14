import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('new account architecture isolates QQ and user-owned sync state', () => {
  const suffix = `${process.pid}-${Date.now()}`
  const databasePath = `/tmp/x-music-auth-redesign-${suffix}.sqlite`
  const dataDir = `/tmp/x-music-auth-redesign-${suffix}`
  const script = `
    import assert from 'node:assert/strict'
    import { createUser } from './src/lib/db/users.ts'
    import { bindQQAuthorization, getAccountByUserId } from './src/lib/db/accounts.ts'
    import { db } from './src/lib/db/index.ts'
    import { ensureTrack } from './src/lib/cache/store.ts'
    import { enqueuePendingEmbyTrackSyncs, requestUserTrackSync } from './src/lib/emby/sync.ts'
    import { localEmbyUserId } from './src/lib/emby/tokens.ts'

    const first = await createUser({ username: 'Owner_One', password: 'correct-horse-1' })
    const second = await createUser({ username: 'Listener.Two', password: 'correct-horse-2' })
    assert.equal(first.user.role, 'admin')
    assert.equal(second.user.role, 'user')
    assert.equal(getAccountByUserId(first.user.id).embyUsername, 'owner_one')
    assert.equal(getAccountByUserId(second.user.id).embyUsername, 'listener.two')

    bindQQAuthorization(first.user.id, 'uin=o100001; qm_keyst=first-key')
    bindQQAuthorization(second.user.id, 'uin=o100002; qm_keyst=second-key')
    assert.equal(getAccountByUserId(first.user.id).qqUin, '100001')
    assert.equal(getAccountByUserId(second.user.id).qqUin, '100002')
    await assert.rejects(
      async () => bindQQAuthorization(second.user.id, 'uin=o100001; qm_keyst=duplicate-key'),
      /QQ_ALREADY_BOUND/,
    )

    db.prepare('UPDATE user_emby_profiles SET source_webdav_dsn = ? WHERE user_id = ?')
      .run('https://webdav.example/dav/music', first.user.id)
    const song = { source: 'tx', songmid: 'shared-track', name: 'Shared Track', singer: 'Tester' }
    const track = ensureTrack(song)
    assert.equal(requestUserTrackSync(first.user.id, track.id, 'playback'), true)
    assert.equal(requestUserTrackSync(second.user.id, track.id, 'favorite'), false)
    enqueuePendingEmbyTrackSyncs(song)
    const jobs = db.prepare("SELECT user_id FROM jobs WHERE type = 'sync_emby_track' ORDER BY user_id").all()
    assert.deepEqual(jobs.map(row => row.user_id), [first.user.id])
    assert.equal(db.prepare('SELECT 1 FROM user_track_sync_requests WHERE user_id = ? AND track_id = ?').get(second.user.id, track.id), undefined)
    assert.notEqual(localEmbyUserId(first.user.id), localEmbyUserId(second.user.id))
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'accounts'").get(), undefined)
  `

  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'development',
        DATABASE_URL: `file:${databasePath}`,
        MUSIC_DATA_DIR: dataDir,
      },
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  } finally {
    rmSync(databasePath, { force: true })
    rmSync(`${databasePath}-shm`, { force: true })
    rmSync(`${databasePath}-wal`, { force: true })
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('beta reset removes legacy users and credentials while preserving shared media', () => {
  const suffix = `${process.pid}-${Date.now()}`
  const dataDir = `/tmp/x-music-beta-reset-${suffix}`
  const databasePath = `${dataDir}/app.sqlite`
  const script = `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import path from 'node:path'
    import Database from 'better-sqlite3'

    fs.mkdirSync(${JSON.stringify(dataDir)}, { recursive: true })
    const legacy = new Database(${JSON.stringify(databasePath)})
    legacy.exec(\`
      CREATE TABLE accounts (qq_uin TEXT PRIMARY KEY);
      CREATE TABLE account_favorites (qq_uin TEXT, track_id INTEGER);
      CREATE TABLE jobs (id INTEGER PRIMARY KEY);
      CREATE TABLE tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, songmid TEXT NOT NULL,
        name TEXT NOT NULL, singer TEXT NOT NULL, album_name TEXT, album_id TEXT,
        interval TEXT, image_url TEXT, raw_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(source, songmid)
      );
      CREATE TABLE track_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT, track_id INTEGER NOT NULL, quality TEXT NOT NULL,
        status TEXT NOT NULL, raw_path TEXT, final_path TEXT, lyrics_path TEXT, cover_path TEXT,
        size_bytes INTEGER, sha256 TEXT, tagged_at TEXT, error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(track_id, quality)
      );
      CREATE TABLE resource_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT, cache_key TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
        resource_type TEXT NOT NULL, url TEXT NOT NULL, file_path TEXT NOT NULL, content_type TEXT,
        size_bytes INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_accessed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO accounts (qq_uin) VALUES ('100001');
      INSERT INTO account_favorites (qq_uin, track_id) VALUES ('100001', 1);
      INSERT INTO jobs (id) VALUES (1);
      INSERT INTO tracks (source, songmid, name, singer) VALUES ('tx', 'preserved', 'Preserved', 'Tester');
      INSERT INTO track_files (track_id, quality, status, final_path) VALUES (1, '320k', 'ready', '/music/preserved.mp3');
      INSERT INTO resource_cache (cache_key, source, resource_type, url, file_path) VALUES ('cover:1', 'tx', 'cover', 'https://example.test/cover', '/cache/cover.jpg');
      INSERT INTO app_settings (key, value_json) VALUES ('emby.username', '"old-user"');
      INSERT INTO app_settings (key, value_json) VALUES ('emby.upstreamMusicLibraryMapping.100001', '{}');
      INSERT INTO app_settings (key, value_json) VALUES ('qq.enabled', 'true');
    \`)
    legacy.close()

    const { db } = await import('./src/lib/db/index.ts')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0)
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'accounts'").get(), undefined)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tracks').get().count, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM track_files').get().count, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM resource_cache').get().count, 1)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM app_settings WHERE key LIKE 'emby.%'").get().count, 0)
    assert.equal(db.prepare("SELECT value_json FROM app_settings WHERE key = 'qq.enabled'").get().value_json, 'true')
    assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value, '2')
    assert.ok(fs.readdirSync(path.dirname(${JSON.stringify(databasePath)})).some(name => name.includes('.pre-user-reset-') && name.endsWith('.bak')))
  `

  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'development',
        DATABASE_URL: `file:${databasePath}`,
        MUSIC_DATA_DIR: dataDir,
      },
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
