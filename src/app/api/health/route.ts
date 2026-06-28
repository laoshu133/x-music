import fs from 'node:fs'
import { NextResponse } from 'next/server'
import { appConfig } from '@/lib/config'
import { listResourceCacheSummary } from '@/lib/cache/resources'
import { db } from '@/lib/db'
import { getFavoriteSummary } from '@/lib/db/favorites'
import { getJobSummary } from '@/lib/jobs/status'
import { getCurrentAccount } from '@/lib/session'
import { isAdminQQ, type AccountRecord } from '@/lib/db/accounts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface CountRow {
  count: number
}

export async function GET() {
  const account = await getCurrentAccount({ verifyQQ: false })
  const isAdmin = isAdminQQ(account?.qqUin)
  const database = checkDatabase()
  const cache = {
    dataDir: checkDirectory(appConfig.dataDir),
    stagingDir: checkDirectory(appConfig.stagingDir),
    inboxDir: checkDirectory(appConfig.inboxDir),
    musicDir: checkDirectory(appConfig.musicDir),
  }
  const jobs = isAdmin ? getJobStatus() : emptyJobStatus()
  const favorites = getFavoriteSummary()
  const resourceCache = listResourceCacheSummary()
  const config = {
    missing: [
      ...(!appConfig.lxMusicSourceScript ? ['LX_MUSIC_SOURCE_SCRIPT'] : []),
    ],
    lxMusicSourceScript: Boolean(appConfig.lxMusicSourceScript),
  }

  const ok = database.ok
    && Object.values(cache).every(item => item.exists && item.writable)
    && config.missing.length === 0
    && account?.qqAuthState !== 'expired'

  return NextResponse.json({
    ok,
    checkedAt: new Date().toISOString(),
    account: accountStatus(account),
    database,
    cache,
    jobs,
    favorites,
    resourceCache,
    audioCache: getAudioCacheStatus(),
    sync: getSyncStatus(isAdmin, account),
    config,
    permissions: { isAdmin },
  }, { status: ok ? 200 : 503 })
}

const accountStatus = (account: AccountRecord | undefined) => {
  if (!account) {
    return {
      loggedIn: false,
      qqAuthState: 'missing',
      embyConfigured: false,
      webdavConfigured: false,
      embyGatewayUsername: undefined,
      hasEmbyApiKey: false,
      proxyTimeoutMs: undefined,
    }
  }

  return {
    loggedIn: true,
    qqUin: account.qqUin,
    qqNickname: account.qqNickname,
    qqAuthState: account.qqAuthState,
    qqAuthCheckedAt: account.qqAuthCheckedAt,
    qqAuthError: account.qqAuthError,
    embyGatewayUsername: account.embyUsername,
    embyConfigured: Boolean(account.embyBaseUrl && account.embyApiKey),
    embyBaseUrlConfigured: Boolean(account.embyBaseUrl),
    hasEmbyApiKey: Boolean(account.embyApiKey),
    webdavConfigured: Boolean(account.embySourceWebdavDsn),
    proxyTimeoutMs: account.embyProxyTimeoutMs ?? 30000,
  }
}

const checkDatabase = () => {
  try {
    const tracks = count('tracks')
    const trackFiles = count('track_files')
    const playEvents = count('play_events')
    db.prepare('SELECT 1').get()
    return {
      ok: true,
      url: appConfig.databaseUrl,
      tracks,
      trackFiles,
      playEvents,
    }
  } catch (error) {
    return {
      ok: false,
      url: appConfig.databaseUrl,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const checkDirectory = (dirPath: string) => {
  try {
    fs.mkdirSync(dirPath, { recursive: true })
    fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK)
    const stat = fs.statSync(dirPath)
    return {
      path: dirPath,
      exists: true,
      writable: true,
      isDirectory: stat.isDirectory(),
      entries: stat.isDirectory() ? fs.readdirSync(dirPath).length : 0,
    }
  } catch (error) {
    return {
      path: dirPath,
      exists: fs.existsSync(dirPath),
      writable: false,
      isDirectory: false,
      entries: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const getJobStatus = () => {
  const summary = getJobSummary()
  return {
    byStatus: {
      queued: summary.queued,
      running: summary.running,
      completed: summary.completed,
      failed: summary.failed,
    },
    byType: summary.byType,
    total: summary.total,
    queued: summary.queued,
    running: summary.running,
    completed: summary.completed,
    failed: summary.failed,
  }
}

const emptyJobStatus = () => ({
  byStatus: {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
  },
  byType: {},
  total: 0,
  queued: 0,
  running: 0,
  completed: 0,
  failed: 0,
})

const count = (tableName: string): number => {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as CountRow
  return row.count
}

const observedJobTypes = ['archive_track', 'sync_emby_track', 'tag_track_file', 'cleanup_track_cache'] as const

const getAudioCacheStatus = () => {
  const rows = db.prepare(`
    SELECT quality, status, COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
    FROM track_files
    GROUP BY quality, status
  `).all() as Array<{ quality: string; status: string; count: number; bytes: number }>

  const byQuality: Record<string, { total: number; bytes: number; byStatus: Record<string, number> }> = {}
  const byStatus: Record<string, number> = {}
  let total = 0
  let totalBytes = 0
  let lyrics = 0
  let covers = 0

  for (const row of rows) {
    byQuality[row.quality] ??= { total: 0, bytes: 0, byStatus: {} }
    byQuality[row.quality]!.total += row.count
    byQuality[row.quality]!.bytes += row.bytes
    byQuality[row.quality]!.byStatus[row.status] = row.count
    byStatus[row.status] = (byStatus[row.status] ?? 0) + row.count
    total += row.count
    totalBytes += row.bytes
  }

  const resourceRows = db.prepare(`
    SELECT
      SUM(CASE WHEN lyrics_path IS NOT NULL THEN 1 ELSE 0 END) AS lyrics,
      SUM(CASE WHEN cover_path IS NOT NULL THEN 1 ELSE 0 END) AS covers
    FROM track_files
  `).get() as { lyrics?: number | null; covers?: number | null } | undefined
  lyrics = resourceRows?.lyrics ?? 0
  covers = resourceRows?.covers ?? 0

  return {
    total,
    totalBytes,
    byQuality,
    byStatus,
    lyrics,
    covers,
    ready: byStatus.ready ?? 0,
    tagging: byStatus.tagging ?? 0,
    cachedRaw: byStatus.cached_raw ?? 0,
    failed: byStatus.failed ?? 0,
    missing: byStatus.missing ?? 0,
  }
}

const getSyncStatus = (isAdmin: boolean, account: AccountRecord | undefined) => {
  const jobTypes = getObservedJobTypes()
  return {
    jobs: Object.fromEntries(jobTypes.map(type => [type, getJobTypeStatus(type, isAdmin, account)])),
    recentFailures: isAdmin ? recentJobFailures(account) : [],
    webdav: getRecentWebdavEvents(account),
  }
}

const getObservedJobTypes = (): string[] => {
  const rows = db.prepare(`
    SELECT DISTINCT type
    FROM jobs
    WHERE type IN (${observedJobTypes.map((_, index) => `@type${index}`).join(',')})
  `).all(Object.fromEntries(observedJobTypes.map((type, index) => [`type${index}`, type]))) as Array<{ type: string }>
  const seen = new Set(rows.map(row => row.type))
  return observedJobTypes.filter(type => seen.has(type) || type === 'archive_track' || type === 'sync_emby_track' || type === 'tag_track_file')
}

const getJobTypeStatus = (type: string, isAdmin: boolean, account: AccountRecord | undefined) => {
  if (!isAdmin) {
    return { total: 0, queued: 0, running: 0, completed: 0, failed: 0 }
  }
  const params: Record<string, unknown> = { type }
  const clauses = ['type = @type']
  if (account?.qqUin) {
    clauses.push("(json_extract(payload_json, '$.qqUin') = @qqUin OR json_extract(payload_json, '$.qqUin') IS NULL)")
    params.qqUin = account.qqUin
  }
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM jobs
    WHERE ${clauses.join(' AND ')}
    GROUP BY status
  `).all(params) as Array<{ status: string; count: number }>

  const result = { total: 0, queued: 0, running: 0, completed: 0, failed: 0 }
  for (const row of rows) {
    result.total += row.count
    if (row.status === 'queued') result.queued += row.count
    if (row.status === 'running') result.running += row.count
    if (row.status === 'completed') result.completed += row.count
    if (row.status === 'failed') result.failed += row.count
  }
  return result
}

const recentJobFailures = (account: AccountRecord | undefined) => {
  const params: Record<string, unknown> = {}
  const clauses = ["status = 'failed'"]
  if (account?.qqUin) {
    clauses.push("(json_extract(payload_json, '$.qqUin') = @qqUin OR json_extract(payload_json, '$.qqUin') IS NULL)")
    params.qqUin = account.qqUin
  }
  const rows = db.prepare(`
    SELECT id, type, error, updated_at AS updatedAt
    FROM jobs
    WHERE ${clauses.join(' AND ')}
    ORDER BY updated_at DESC, id DESC
    LIMIT 3
  `).all(params) as Array<{ id: number; type: string; error?: string | null; updatedAt: string }>
  return rows.map(row => ({
    id: row.id,
    type: row.type,
    error: row.error ?? '',
    updatedAt: row.updatedAt,
  }))
}

const getRecentWebdavEvents = (account: AccountRecord | undefined) => {
  const params: Record<string, unknown> = {}
  const clauses = ["type = 'emby_webdav'", "updated_at >= datetime('now', '-7 days')"]
  if (account?.qqUin) {
    clauses.push("json_extract(payload_json, '$.qqUin') = @qqUin")
    params.qqUin = account.qqUin
  }
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM sync_events
    WHERE ${clauses.join(' AND ')}
    GROUP BY status
  `).all(params) as Array<{ status: string; count: number }>
  const result = {
    uploaded: 0,
    skippedExisting: 0,
  }
  for (const row of rows) {
    if (row.status === 'uploaded') result.uploaded += row.count
    if (row.status === 'skipped_existing') result.skippedExisting += row.count
  }
  return result
}
