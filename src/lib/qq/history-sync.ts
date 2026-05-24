import { listPlayHistory } from '@/lib/cache/store'
import { resolveMusicUrlWithFallback } from '@/lib/music-url/resolve'
import { syncQQPlayHistory } from './history'

export async function pushLocalPlayHistoryToQQ(input: {
  cookie?: string
  limit?: number
} = {}): Promise<{
  source: 'qq'
  attempted: number
  synced: number
  failed: number
  errors: Array<{ songmid: string; error: string }>
}> {
  const events = listPlayHistory(input.limit ?? 200)
  const errors: Array<{ songmid: string; error: string }> = []
  let synced = 0

  for (const event of events) {
    try {
      const resolved = await resolveMusicUrlWithFallback(event, event.quality)
      const result = await syncQQPlayHistory({
        cookie: input.cookie,
        musicInfo: event,
        quality: resolved.quality,
        playUrl: resolved.url,
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
