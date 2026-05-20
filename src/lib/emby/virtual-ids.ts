import type { MusicInfo } from '@/lib/types'

export type VirtualId =
  | { kind: 'qq-song'; songmid: string; playlistId?: string }
  | { kind: 'qq-playlist'; id: string }
  | { kind: 'qq-daily' }
  | { kind: 'qq-guess' }

export function encodeVirtualId(input: VirtualId): string {
  const raw = JSON.stringify(input)
  return `mix_${Buffer.from(raw, 'utf8').toString('base64url')}`
}

export function decodeVirtualId(id: string): VirtualId | undefined {
  if (!id.startsWith('mix_')) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(id.slice(4), 'base64url').toString('utf8')) as VirtualId
    if (parsed.kind === 'qq-song' && parsed.songmid) return parsed
    if (parsed.kind === 'qq-playlist' && parsed.id) return parsed
    if (parsed.kind === 'qq-daily' || parsed.kind === 'qq-guess') return parsed
  } catch {
    return undefined
  }
  return undefined
}

export function songVirtualId(song: MusicInfo, playlistId?: string): string {
  return encodeVirtualId({ kind: 'qq-song', songmid: song.songmid, playlistId })
}

export function playlistVirtualId(id: string): string {
  return encodeVirtualId({ kind: 'qq-playlist', id })
}
