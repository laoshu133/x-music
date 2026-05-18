export function formatDuration(seconds?: number) {
  if (!seconds || seconds < 0) return ''
  const minute = Math.floor(seconds / 60)
  const second = Math.floor(seconds % 60)
  return `${minute}:${second.toString().padStart(2, '0')}`
}

export function formatSize(bytes?: number) {
  if (!bytes) return undefined
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)}KB`
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`
}

export function decodeHtml(value?: string) {
  if (!value) return ''
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<br\s*\/?>/gi, '\n')
}

export function formatPlayCount(count?: number) {
  if (!count) return '0'
  if (count >= 100000000) return `${(count / 100000000).toFixed(1)}亿`
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万`
  return String(count)
}

export function formatDate(input?: number | string) {
  if (!input) return ''
  const date = typeof input === 'number' ? new Date(input * 1000) : new Date(input)
  if (Number.isNaN(date.getTime())) return ''
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}
