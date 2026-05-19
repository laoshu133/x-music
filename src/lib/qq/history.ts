import type { MusicInfo, MusicQuality } from '@/lib/types'
import { getQQLoginState } from './account'
import { QQMusicError, qqPost } from './http'

type QQPlayHistoryResponse = {
  code: number
  req?: {
    code?: number
    msg?: string
    message?: string
    data?: unknown
  }
}

export type QQPlayHistorySyncResult =
  | { synced: true; skipped?: false; raw?: unknown }
  | { synced: false; skipped: true; reason: string }
  | { synced: false; skipped?: false; error: string }

function buildPlayHistoryPayload(input: { loginUin: string; musicInfo: MusicInfo; quality: MusicQuality }) {
  return {
    comm: {
      cv: 4747474,
      ct: 24,
      format: 'json',
      uin: input.loginUin,
      g_tk: 5381,
    },
    req: {
      module: 'music.musicasset.PlayHistoryWrite',
      method: 'AddPlayHistory',
      param: {
        uin: input.loginUin,
        songMids: [input.musicInfo.songmid],
        songmid: input.musicInfo.songmid,
        source: 0,
        quality: input.quality,
        timestamp: Math.floor(Date.now() / 1000),
      },
    },
  }
}

function assertPlayHistorySuccess(data: QQPlayHistoryResponse) {
  if (data.code === 0 && (data.req?.code === 0 || data.req?.code === undefined)) return

  throw new QQMusicError('QQ play history write request was rejected', 502, {
    actionable: 'QQ Music does not publish a stable play-history write API. Recheck the private module/method with a real authenticated player request.',
    response: data,
  })
}

export async function syncQQPlayHistory(input: {
  cookie?: string
  musicInfo: MusicInfo
  quality: MusicQuality
}): Promise<QQPlayHistorySyncResult> {
  const login = getQQLoginState(input)
  if (!login) {
    return { synced: false, skipped: true, reason: 'QQ Music login cookie is not configured' }
  }

  try {
    const data = await qqPost<QQPlayHistoryResponse>(
      'https://u.y.qq.com/cgi-bin/musicu.fcg',
      buildPlayHistoryPayload({ loginUin: login.uin, musicInfo: input.musicInfo, quality: input.quality }),
      {
        headers: {
          cookie: login.cookie,
          referer: 'https://y.qq.com/portal/player.html',
        },
      },
    )
    assertPlayHistorySuccess(data)
    return { synced: true, raw: data.req?.data }
  } catch (error) {
    return {
      synced: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function syncQQPlayHistoryBestEffort(input: {
  cookie?: string
  musicInfo: MusicInfo
  quality: MusicQuality
}): void {
  void syncQQPlayHistory(input).then((result) => {
    if (!result.synced) {
      const detail = result.skipped ? result.reason : result.error
      console.warn(`QQ play history sync skipped/failed for ${input.musicInfo.songmid}: ${detail}`)
    }
  }).catch((error: unknown) => {
    console.warn(
      `QQ play history sync crashed for ${input.musicInfo.songmid}: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
}
