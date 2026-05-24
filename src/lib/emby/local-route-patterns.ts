export function isUserRequest(path: string): boolean {
  return pathEquals(path, '/Users/Current') || /^\/Users\/[^/]+$/i.test(path)
}

export function isUserViewsRequest(path: string): boolean {
  return /^\/Users\/[^/]+\/Views$/i.test(path)
}

export function isItemsRequest(path: string): boolean {
  return /^\/Users\/[^/]+\/Items$/i.test(path) || path === '/Items'
}

export function isItemRequest(path: string): boolean {
  return /^\/Users\/[^/]+\/Items\/[^/]+\/?$/i.test(path) || /^\/Items\/[^/]+\/?$/i.test(path)
}

export function isFavoriteItemMutationRequest(path: string): boolean {
  return /^\/Users\/[^/]+\/FavoriteItems\/[^/]+(?:\/Delete)?$/i.test(path)
}

export function isItemsDeleteRequest(method: string, path: string): boolean {
  return (method === 'POST' && pathEquals(path, '/Items/Delete'))
    || (method === 'DELETE' && isItemRequest(path))
}

export function isFavoriteItemMutation(method: string, path: string): boolean {
  return (method === 'POST' || method === 'DELETE') && isFavoriteItemMutationRequest(path)
}

export function isPlaybackInfoRequest(path: string): boolean {
  return /^\/Items\/[^/]+\/PlaybackInfo$/i.test(path) || /^\/Users\/[^/]+\/Items\/[^/]+\/PlaybackInfo$/i.test(path)
}

export function isSimilarItemsRequest(path: string): boolean {
  return /^\/Items\/[^/]+\/Similar$/i.test(path) || /^\/Users\/[^/]+\/Items\/[^/]+\/Similar$/i.test(path)
}

export function isLyricsRequest(path: string): boolean {
  return /^\/Items\/[^/]+\/Lyrics(?:\/[^/]+)?$/i.test(path)
    || /^\/Users\/[^/]+\/Items\/[^/]+\/Lyrics(?:\/[^/]+)?$/i.test(path)
    || /^\/Audio\/[^/]+\/Lyrics(?:\/[^/]+)?$/i.test(path)
}

export function isSubsonicGetSongRequest(path: string): boolean {
  return pathEquals(path, '/rest/getSong.view')
}

export function isSubsonicLyricsRequest(path: string): boolean {
  return pathEquals(path, '/rest/getLyricsBySongId.view')
}

export function isSubtitleStreamRequest(path: string): boolean {
  return /^\/Items\/[^/]+\/[^/]+\/Subtitles\/\d+(?:\/\d+)?\/Stream\.[^/]+$/i.test(path)
    || /^\/Items\/[^/]+\/Subtitles\/\d+(?:\/\d+)?\/Stream\.[^/]+$/i.test(path)
    || /^\/Videos\/[^/]+\/[^/]+\/Subtitles\/\d+(?:\/\d+)?\/Stream\.[^/]+$/i.test(path)
    || /^\/Videos\/[^/]+\/Subtitles\/\d+(?:\/\d+)?\/Stream\.[^/]+$/i.test(path)
}

export function isPlaylistItemsRequest(path: string): boolean {
  return /^\/Playlists\/[^/]+\/Items$/i.test(path) || /^\/Users\/[^/]+\/Items\/[^/]+\/Items$/i.test(path)
}

export function isAudioRequest(path: string): boolean {
  return /^\/Audio\/[^/]+\/(?:universal|stream)(?:\.[^/?]+)?$/i.test(path)
}

export function isPlaybackReportRequest(path: string): boolean {
  return /^\/Sessions\/Playing(?:\/(?:Progress|Stopped))?$/i.test(path)
}

export function isGenresCollectionPath(path: string): boolean {
  return /^\/Users\/[^/]+\/Genres$/i.test(path) || /^\/(?:Genres|MusicGenres)$/i.test(path)
}

export function isImageRequest(path: string): boolean {
  return /^\/Items\/[^/]+\/Images\/[^/]+(?:\/[^/]+)?$/i.test(path) || /^\/Users\/[^/]+\/Images\/[^/]+(?:\/[^/]+)?$/i.test(path)
}

export function extractPlaylistId(path: string): string | undefined {
  const playlistMatch = path.match(/^\/Playlists\/([^/]+)\/Items$/i)
  if (playlistMatch?.[1]) return decodeURIComponent(playlistMatch[1])
  const userItemMatch = path.match(/^\/Users\/[^/]+\/Items\/([^/]+)\/Items$/i)
  return userItemMatch?.[1] ? decodeURIComponent(userItemMatch[1]) : undefined
}

export function extractItemId(path: string): string | undefined {
  const itemMatch = path.match(/^\/Items\/([^/]+)$/i)
  if (itemMatch?.[1]) return decodeURIComponent(itemMatch[1])
  const userItemMatch = path.match(/^\/Users\/[^/]+\/Items\/([^/]+)$/i)
  return userItemMatch?.[1] ? decodeURIComponent(userItemMatch[1]) : undefined
}

export function extractFavoriteItemId(path: string): string | undefined {
  const favoriteItemMatch = path.match(/^\/Users\/[^/]+\/FavoriteItems\/([^/]+)(?:\/Delete)?$/i)
  return favoriteItemMatch?.[1] ? decodeURIComponent(favoriteItemMatch[1]) : undefined
}

export function extractNestedItemId(path: string, action: string): string | undefined {
  const itemMatch = path.match(new RegExp(`^/Items/([^/]+)/${action}(?:/[^/]+)?$`, 'i'))
  if (itemMatch?.[1]) return decodeURIComponent(itemMatch[1])
  const userItemMatch = path.match(new RegExp(`^/Users/[^/]+/Items/([^/]+)/${action}(?:/[^/]+)?$`, 'i'))
  if (userItemMatch?.[1]) return decodeURIComponent(userItemMatch[1])
  const audioMatch = path.match(new RegExp(`^/Audio/([^/]+)/${action}(?:/[^/]+)?$`, 'i'))
  return audioMatch?.[1] ? decodeURIComponent(audioMatch[1]) : undefined
}

export function extractSubtitleItemId(path: string): string | undefined {
  const itemMatch = path.match(/^\/(?:Items|Videos)\/([^/]+)(?:\/[^/]+)?\/Subtitles\/\d+(?:\/\d+)?\/Stream\.[^/]+$/i)
  return itemMatch?.[1] ? decodeURIComponent(itemMatch[1]) : undefined
}

export function extractImageItemId(path: string): string | undefined {
  const itemMatch = path.match(/^\/Items\/([^/]+)\/Images\/[^/]+(?:\/[^/]+)?$/i)
  if (itemMatch?.[1]) return decodeURIComponent(itemMatch[1])
  const userMatch = path.match(/^\/Users\/([^/]+)\/Images\/[^/]+(?:\/[^/]+)?$/i)
  return userMatch?.[1] ? decodeURIComponent(userMatch[1]) : undefined
}

function pathEquals(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}
