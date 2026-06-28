import { NextResponse } from 'next/server'
import { getAccountByQQ } from '@/lib/db/accounts'
import { getStoredQQLoginState } from '@/lib/db/qq-session'
import { getEffectiveSettings } from '@/lib/db/settings'
import { incrementalSyncQQToEmby } from '@/lib/emby/incremental-sync'
import { getCurrentAccount } from '@/lib/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(): Promise<Response> {
  const account = await getCurrentAccountForEmbySync()
  if (!account) return NextResponse.json({ error: 'Login required' }, { status: 401 })

  const settings = getEffectiveSettings()
  const syncFavorites = settings.qq.syncFavorites
  const syncPlaylists = settings.qq.syncPlaylists
  if (!syncFavorites && !syncPlaylists) {
    return NextResponse.json({
      error: '请先在 QQ 音乐配置中开启“同步我的收藏”或“同步歌单”。',
    }, { status: 400 })
  }

  try {
    const result = await incrementalSyncQQToEmby({ account, syncFavorites, syncPlaylists })
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status: 502 })
  }
}

async function getCurrentAccountForEmbySync() {
  try {
    return await getCurrentAccount()
  } catch (error) {
    if (
      process.env.NODE_ENV !== 'test'
      || !String(error instanceof Error ? error.message : error).includes('outside a request scope')
    ) {
      throw error
    }
    const stored = getStoredQQLoginState()
    return stored ? getAccountByQQ(stored.uin) : undefined
  }
}
