import fs from 'node:fs'
import { NextResponse } from 'next/server'
import { appConfig } from '@/lib/config'
import { db } from '@/lib/db'
import { getFavoriteSummary } from '@/lib/db/favorites'

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
  const config = {
    missing: [
      ...(!appConfig.lxMusicUrlScript ? ['LX_MUSIC_URL_SCRIPT'] : []),
    ],
    lxMusicUrlScript: Boolean(appConfig.lxMusicUrlScript),
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
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM jobs
    GROUP BY status
  `).all() as Array<{ status: string; count: number }>

  return {
    byStatus: Object.fromEntries(rows.map(row => [row.status, row.count])),
    queued: jobCount('queued'),
    running: jobCount('running'),
    failed: jobCount('failed'),
  }
}

const count = (tableName: string): number => {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as CountRow
  return row.count
}

const jobCount = (status: string): number => {
  const row = db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE status = ?').get(status) as CountRow
  return row.count
}
