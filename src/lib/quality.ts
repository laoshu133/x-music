import type { MusicQuality } from './types'

export const preferredQualities: MusicQuality[] = ['flac', '320k', '128k']

export const isMusicQuality = (value: string): value is MusicQuality => {
  return value === 'flac' || value === '320k' || value === '128k'
}
