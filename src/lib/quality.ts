import type { MusicInfo, MusicQuality } from './types'

export const preferredQualities: MusicQuality[] = ['flac', '320k', '128k']

export const isMusicQuality = (value: string): value is MusicQuality => {
  return value === 'flac' || value === '320k' || value === '128k'
}

export const highestAvailableQuality = (musicInfo: Pick<MusicInfo, 'types'>): MusicQuality => {
  const available = new Set((musicInfo.types ?? [])
    .map(item => item.type)
    .filter((quality): quality is MusicQuality => isMusicQuality(quality)))
  return preferredQualities.find(quality => available.has(quality)) ?? preferredQualities[0]
}

export const isHighestAvailableQuality = (
  musicInfo: Pick<MusicInfo, 'types'>,
  quality: MusicQuality,
): boolean => quality === highestAvailableQuality(musicInfo)
