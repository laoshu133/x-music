import fs from 'node:fs'
import { NextResponse } from 'next/server'
import { appConfig } from '@/lib/config'
import { listResourceCacheSummary } from '@/lib/cache/resources'
import { db } from '@/lib/db'
import { getFavoriteSummary } from '@/lib/db/favorites'
import { getJobSummary } from '@/lib/jobs/status'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface CountRow {
  count: number
}

export async function GET() {
  const database = checkDatabase()
  const cache = {
    dataDir: checkDirectory(appConfig.dataDir),
    stagingDir: checkDirectory(appConfig.stagingDir),
    inboxDir: checkDirectory(appConfig.inboxDir),
    musicDir: checkDirectory(appConfig.musicDir),
  }
  const jobs = getJobStatus()
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

  return NextResponse.json({
    ok,
    checkedAt: new Date().toISOString(),
    database,
    cache,
    jobs,
    favorites,
    resourceCache,
    config,
  }, { status: ok ? 200 : 503 })
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

const count = (tableName: string): number => {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as CountRow
  return row.count
}
