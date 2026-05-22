import fs from 'node:fs'
import path from 'node:path'
import { appConfig } from '@/lib/config'
import { getEffectiveSettings } from '@/lib/db/settings'

export interface WebdavSyncedMedia {
  embyPath: string
  uploadedPaths: string[]
}

interface WebdavConfig {
  baseUrl: URL
  authHeader?: string
}

export async function syncMediaFilesToEmbyWebdav(input: {
  finalPath: string
  lyricsPath?: string
  coverPath?: string
}): Promise<WebdavSyncedMedia | undefined> {
  const dsn = getEffectiveSettings().emby.sourceWebdavDsn
  if (!dsn) return undefined

  const relativeFinalPath = relativeMusicPath(input.finalPath)
  const files = [
    input.finalPath,
    input.lyricsPath,
    input.coverPath,
  ].filter((filePath): filePath is string => Boolean(filePath && fs.existsSync(filePath)))

  const config = parseWebdavDsn(dsn)
  const uploadedPaths: string[] = []
  const createdDirectories = new Set<string>()

  for (const filePath of files) {
    const relativePath = relativeMusicPath(filePath)
    await ensureRemoteDirectories(config, path.dirname(relativePath), createdDirectories)
    await putFile(config, relativePath, filePath)
    uploadedPaths.push(relativePath)
  }

  return {
    embyPath: toPosixPath(relativeFinalPath),
    uploadedPaths,
  }
}

function relativeMusicPath(filePath: string): string {
  const relativePath = path.relative(appConfig.musicDir, filePath)
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`WebDAV sync path is outside MUSIC_DATA_DIR/music: ${filePath}`)
  }
  return relativePath
}

function parseWebdavDsn(dsn: string): WebdavConfig {
  const baseUrl = new URL(dsn)
  const username = decodeURIComponent(baseUrl.username)
  const password = decodeURIComponent(baseUrl.password)
  baseUrl.username = ''
  baseUrl.password = ''
  return {
    baseUrl,
    authHeader: username ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` : undefined,
  }
}

async function ensureRemoteDirectories(config: WebdavConfig, relativeDir: string, createdDirectories: Set<string>): Promise<void> {
  if (!relativeDir || relativeDir === '.') return

  const parts = toPosixPath(relativeDir).split('/').filter(Boolean)
  let current = ''
  for (const part of parts) {
    current = current ? `${current}/${part}` : part
    if (createdDirectories.has(current)) continue
    const response = await webdavFetch(config, current, {
      method: 'MKCOL',
    })
    if (!response.ok && response.status !== 405) {
      throw new Error(`WebDAV MKCOL ${current} failed with ${response.status}: ${(await response.text().catch(() => '')).slice(0, 300)}`)
    }
    createdDirectories.add(current)
  }
}

async function putFile(config: WebdavConfig, relativePath: string, filePath: string): Promise<void> {
  const stat = await fs.promises.stat(filePath)
  const response = await webdavFetch(config, relativePath, {
    method: 'PUT',
    headers: {
      'content-length': String(stat.size),
      'content-type': contentTypeFromPath(filePath),
    },
    body: fs.createReadStream(filePath) as unknown as BodyInit,
    duplex: 'half',
  } as RequestInit)
  if (!response.ok) {
    throw new Error(`WebDAV PUT ${relativePath} failed with ${response.status}: ${(await response.text().catch(() => '')).slice(0, 300)}`)
  }
}

async function webdavFetch(config: WebdavConfig, relativePath: string, init: RequestInit): Promise<Response> {
  const url = webdavUrl(config.baseUrl, relativePath)
  const headers = new Headers(init.headers)
  if (config.authHeader && !headers.has('authorization')) headers.set('authorization', config.authHeader)
  return fetch(url, {
    ...init,
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(getEffectiveSettings().emby.proxyTimeoutMs),
  })
}

function webdavUrl(baseUrl: URL, relativePath: string): URL {
  const url = new URL(baseUrl.href)
  const basePath = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname
  const encodedRelativePath = toPosixPath(relativePath)
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
  url.pathname = encodedRelativePath ? `${basePath}/${encodedRelativePath}` : basePath || '/'
  return url
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/')
}

function contentTypeFromPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.lrc' || extension === '.txt') return 'text/plain; charset=utf-8'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.png') return 'image/png'
  if (extension === '.flac') return 'audio/flac'
  if (extension === '.mp3') return 'audio/mpeg'
  if (extension === '.m4a') return 'audio/mp4'
  return 'application/octet-stream'
}
