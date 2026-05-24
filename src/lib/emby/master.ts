import { createUpstreamTeeResponse } from '@/lib/cache/stream'
import { getPlayableTrackFile, hasActiveTrackFile } from '@/lib/cache/store'
import { highestAvailableQuality } from '@/lib/quality'
import { resolveMusicUrl } from '@/lib/music-url/resolve'
import type { MusicInfo, TrackRecord } from '@/lib/types'

export function ensureEmbyMasterCachedBestEffort(input: {
  musicInfo: MusicInfo
  track: TrackRecord
}): void {
  void ensureEmbyMasterCached(input).catch((error: unknown) => {
    if (process.env.X_MUSIC_DEBUG_BACKGROUND_SYNC === '1') {
      console.debug(
        `failed to cache Emby master for ${input.musicInfo.source}:${input.musicInfo.songmid}`,
        error,
      )
    }
  })
}

export async function ensureEmbyMasterCached(input: {
  musicInfo: MusicInfo
  track: TrackRecord
}): Promise<void> {
  const quality = highestAvailableQuality(input.musicInfo)
  if (getPlayableTrackFile(input.musicInfo.source, input.musicInfo.songmid, quality)) return
  if (hasActiveTrackFile(input.musicInfo.source, input.musicInfo.songmid, [quality])) return

  const resolved = await resolveMusicUrl(input.musicInfo, quality)
  const { response, completion } = await createUpstreamTeeResponse(
    resolved.url,
    input.track,
    resolved.quality,
    new Request('http://x-music.local/internal/emby-master-cache'),
    resolved.ekey,
    { librarySync: true },
  )
  if (!response.ok) throw new Error(`master cache upstream returned ${response.status}`)
  await response.arrayBuffer()
  await completion
}
