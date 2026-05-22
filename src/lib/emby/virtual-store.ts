import type { MusicInfo, QQPlaylistInfo } from '@/lib/types'
import { db } from '@/lib/db'

export function rememberVirtualSong(song: MusicInfo, playlistId?: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value_json, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
  `).run(`virtual.song.${song.songmid}`, JSON.stringify({ song, playlistId }))
}

export function loadVirtualSong(songmid: string): { song: MusicInfo; playlistId?: string } | undefined {
  const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(`virtual.song.${songmid}`) as { value_json: string } | undefined
  if (!row) return undefined
  return JSON.parse(row.value_json) as { song: MusicInfo; playlistId?: string }
}

export function listVirtualSongs(): Array<{ song: MusicInfo; playlistId?: string }> {
  const rows = db.prepare(`
    SELECT value_json
    FROM app_settings
    WHERE key LIKE 'virtual.song.%'
    ORDER BY updated_at DESC
    LIMIT 500
  `).all() as Array<{ value_json: string }>
  return rows.flatMap((row) => {
    try {
      const parsed = JSON.parse(row.value_json) as { song?: MusicInfo; playlistId?: string }
      return parsed.song ? [{ song: parsed.song, playlistId: parsed.playlistId }] : []
    } catch {
      return []
    }
  })
}

export function rememberVirtualPlaylist(playlist: QQPlaylistInfo): void {
  db.prepare(`
    INSERT INTO app_settings (key, value_json, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
  `).run(`virtual.playlist.${playlist.id}`, JSON.stringify(playlist))
}

export function loadVirtualPlaylist(id: string): QQPlaylistInfo | undefined {
  const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(`virtual.playlist.${id}`) as { value_json: string } | undefined
  if (!row) return undefined
  return JSON.parse(row.value_json) as QQPlaylistInfo
}

export function rememberVirtualAlbumSongs(albumId: string, songs: MusicInfo[]): void {
  db.prepare(`
    INSERT INTO app_settings (key, value_json, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
  `).run(`virtual.album.${albumId}`, JSON.stringify({ songs }))
}

export function loadVirtualAlbumSongs(albumId: string): MusicInfo[] {
  const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(`virtual.album.${albumId}`) as { value_json: string } | undefined
  if (!row) return []
  return (JSON.parse(row.value_json) as { songs?: MusicInfo[] }).songs ?? []
}
