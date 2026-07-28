import { ensureTrack, insertPlayEvent, listPlayHistory } from '@/lib/cache/store'
import { getQQPlayHistory, syncQQPlayHistory } from './history'
import { mapQQSong } from './mapper'

export async function pushLocalPlayHistoryToQQ(input: {
  userId?: string
  cookie?: string
  limit?: number
}): Promise<{
  source: 'qq'
  attempted: number
  synced: number
  failed: number
  errors: Array<{ songmid: string; error: string }>
}> {
  const events = listPlayHistory(input.userId ?? (input.limit ?? 200), input.limit ?? 200)
  const errors: Array<{ songmid: string; error: string }> = []
  let synced = 0

  for (const event of events) {
    try {
      const result = await syncQQPlayHistory({
        cookie: input.cookie,
        musicInfo: event,
        playedAt: event.playedAt,
      })
      if (result.synced) {
        synced += 1
      } else {
        errors.push({
          songmid: event.songmid,
          error: result.skipped ? result.reason : result.error,
        })
      }
    } catch (error) {
      errors.push({ songmid: event.songmid, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return {
    source: 'qq',
    attempted: events.length,
    synced,
    failed: errors.length,
    errors,
  }
}

export async function pullQQPlayHistory(input: {
  userId: string
  cookie?: string
  limit?: number
}): Promise<{
  source: 'qq'
  list: ReturnType<typeof listPlayHistory>
  pulled: number
  skipped: number
  errors: Array<{ songmid?: string; error: string }>
}> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50) || 50, 1), 200)
  const remote = await getQQPlayHistory({ cookie: input.cookie, limit })
  const errors: Array<{ songmid?: string; error: string }> = []
  let pulled = 0
  let skipped = 0

  for (const item of remote.list) {
    const song = item.track ? mapQQSong(item.track) : null
    const lastTime = normalizeRemoteLastTime(item.lastTime)
    if (!song || !lastTime) {
      skipped += 1
      errors.push({
        songmid: item.track?.mid,
        error: !song ? 'QQ history item has no usable track metadata' : 'QQ history item has no valid lastTime',
      })
      continue
    }

    try {
      const track = ensureTrack(song)
      insertPlayEvent(track.id, '320k', input.userId, lastTime)
      pulled += 1
    } catch (error) {
      skipped += 1
      errors.push({
        songmid: song.songmid,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    source: 'qq',
    list: listPlayHistory(input.userId, limit),
    pulled,
    skipped,
    errors,
  }
}

function normalizeRemoteLastTime(value: number | string | undefined): string | undefined {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  const date = new Date(Math.trunc(seconds) * 1000)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}
