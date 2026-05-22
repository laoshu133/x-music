import crypto from 'node:crypto'
import fs from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { appConfig } from '@/lib/config'
import { db } from '@/lib/db'

export type CachedResourceType = 'image' | 'lyrics' | 'metadata' | 'lx-script'

export interface CachedResourceRecord {
  id: number
  cacheKey: string
  source: string
  resourceType: CachedResourceType | string
  url: string
  filePath: string
  contentType?: string
  sizeBytes?: number
  createdAt: string
  updatedAt: string
  lastAccessedAt: string
}

interface ResourceCacheRow {
  id: number
  cache_key: string
  source: string
  resource_type: string
  url: string
  file_path: string
  content_type: string | null
  size_bytes: number | null
  created_at: string
  updated_at: string
  last_accessed_at: string
}

const inflight = new Map<string, Promise<CachedResourceRecord | undefined>>()

export function resourceCacheDir(): string {
  return path.join(appConfig.dataDir, 'resources')
}

export async function getCachedResource(input: {
  source: string
  resourceType: CachedResourceType
  url: string
  headers?: HeadersInit
  method?: string
  body?: BodyInit | null
  timeoutMs?: number
}): Promise<CachedResourceRecord | undefined> {
  const cacheKey = cacheKeyFor(input.source, input.resourceType, requestCacheIdentity(input.url, input.method, input.body))
  const existing = findCachedResource(cacheKey)
  if (existing && fs.existsSync(existing.filePath)) {
    touchCachedResource(cacheKey)
    return existing
  }

  const current = inflight.get(cacheKey)
  if (current) return current

  const pending = fetchAndStoreResource({ ...input, cacheKey })
    .finally(() => inflight.delete(cacheKey))
  inflight.set(cacheKey, pending)
  return pending
}

export async function getCachedTextResource(input: {
  source: string
  resourceType: CachedResourceType
  url: string
  headers?: HeadersInit
  method?: string
  body?: BodyInit | null
  timeoutMs?: number
  transform?: (value: string) => string
}): Promise<string | undefined> {
  const cacheKey = cacheKeyFor(input.source, input.resourceType, requestCacheIdentity(input.url, input.method, input.body))
  const existing = findCachedResource(cacheKey)
  if (existing && fs.existsSync(existing.filePath)) {
    touchCachedResource(cacheKey)
    return fs.promises.readFile(existing.filePath, 'utf8')
  }

  const current = inflight.get(cacheKey)
  if (current) {
    const record = await current
    return record ? fs.promises.readFile(record.filePath, 'utf8') : undefined
  }

  const pending = fetchAndStoreTextResource({ ...input, cacheKey })
    .finally(() => inflight.delete(cacheKey))
  inflight.set(cacheKey, pending)
  const record = await pending
  return record ? fs.promises.readFile(record.filePath, 'utf8') : undefined
}

export function listResourceCacheSummary(): {
  total: number
  totalBytes: number
  byType: Record<string, { count: number; bytes: number }>
} {
  const rows = db.prepare(`
    SELECT resource_type AS type, COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
    FROM resource_cache
    GROUP BY resource_type
  `).all() as Array<{ type: string; count: number; bytes: number }>

  const byType: Record<string, { count: number; bytes: number }> = {}
  let total = 0
  let totalBytes = 0
  for (const row of rows) {
    byType[row.type] = { count: row.count, bytes: row.bytes }
    total += row.count
    totalBytes += row.bytes
  }

  return { total, totalBytes, byType }
}

export async function deleteCachedResourcesForTrack(input: {
  source: string
  songmid: string
  imageUrl?: string
  lyricsUrls?: string[]
}): Promise<void> {
  const keys = [
    input.imageUrl ? cacheKeyFor(input.source, 'image', input.imageUrl) : undefined,
    ...(input.lyricsUrls ?? []).map(url => cacheKeyFor(input.source, 'lyrics', url)),
  ].filter((key): key is string => Boolean(key))

  if (!keys.length) return
  await deleteCachedResourceKeys(keys)
}

export async function deleteCachedResourceKeys(keys: string[]): Promise<void> {
  for (const key of keys) {
    const record = findCachedResource(key)
    if (!record) continue
    await rm(record.filePath, { force: true }).catch(() => undefined)
    db.prepare('DELETE FROM resource_cache WHERE cache_key = ?').run(key)
  }
}

export function cacheKeyFor(source: string, resourceType: CachedResourceType, url: string): string {
  return crypto.createHash('sha256').update(`${source}:${resourceType}:${url}`).digest('hex')
}

export function responseFromCachedResource(record: CachedResourceRecord): Response {
  return new Response(Readable.toWeb(fs.createReadStream(record.filePath)) as BodyInit, {
    status: 200,
    headers: {
      ...(record.contentType ? { 'content-type': record.contentType } : {}),
      ...(record.sizeBytes !== undefined ? { 'content-length': String(record.sizeBytes) } : {}),
      'cache-control': 'public, max-age=86400',
      'x-x-music-cache': 'hit',
    },
  })
}

async function fetchAndStoreResource(input: {
  source: string
  resourceType: CachedResourceType
  url: string
  cacheKey: string
  headers?: HeadersInit
  method?: string
  body?: BodyInit | null
  timeoutMs?: number
}): Promise<CachedResourceRecord | undefined> {
  const response = await fetch(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.body,
    cache: 'no-store',
    signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
  }).catch(() => undefined)
  if (!response?.ok) return undefined

  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim() || undefined
  const bytes = Buffer.from(await response.arrayBuffer())
  return writeCachedBytes({
    source: input.source,
    resourceType: input.resourceType,
    url: input.url,
    cacheKey: input.cacheKey,
    bytes,
    contentType,
  })
}

async function fetchAndStoreTextResource(input: {
  source: string
  resourceType: CachedResourceType
  url: string
  cacheKey: string
  headers?: HeadersInit
  method?: string
  body?: BodyInit | null
  timeoutMs?: number
  transform?: (value: string) => string
}): Promise<CachedResourceRecord | undefined> {
  const response = await fetch(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.body,
    cache: 'no-store',
    signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
  }).catch(() => undefined)
  if (!response?.ok) return undefined

  const text = input.transform ? input.transform(await response.text()) : await response.text()
  return writeCachedBytes({
    source: input.source,
    resourceType: input.resourceType,
    url: input.url,
    cacheKey: input.cacheKey,
    bytes: Buffer.from(text, 'utf8'),
    contentType: response.headers.get('content-type')?.split(';', 1)[0]?.trim() || 'text/plain',
  })
}

async function writeCachedBytes(input: {
  source: string
  resourceType: CachedResourceType
  url: string
  cacheKey: string
  bytes: Buffer
  contentType?: string
}): Promise<CachedResourceRecord> {
  const dir = path.join(resourceCacheDir(), input.resourceType)
  await mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${input.cacheKey}${extensionFromContentType(input.contentType, input.url)}`)
  await writeFile(filePath, input.bytes)

  db.prepare(`
    INSERT INTO resource_cache (
      cache_key,
      source,
      resource_type,
      url,
      file_path,
      content_type,
      size_bytes,
      updated_at,
      last_accessed_at
    )
    VALUES (
      @cacheKey,
      @source,
      @resourceType,
      @url,
      @filePath,
      @contentType,
      @sizeBytes,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(cache_key) DO UPDATE SET
      url = excluded.url,
      file_path = excluded.file_path,
      content_type = excluded.content_type,
      size_bytes = excluded.size_bytes,
      updated_at = CURRENT_TIMESTAMP,
      last_accessed_at = CURRENT_TIMESTAMP
  `).run({
    cacheKey: input.cacheKey,
    source: input.source,
    resourceType: input.resourceType,
    url: input.url,
    filePath,
    contentType: input.contentType ?? null,
    sizeBytes: input.bytes.length,
  })

  return findCachedResource(input.cacheKey)!
}

function findCachedResource(cacheKey: string): CachedResourceRecord | undefined {
  const row = db.prepare('SELECT * FROM resource_cache WHERE cache_key = ?').get(cacheKey) as ResourceCacheRow | undefined
  return row ? mapResource(row) : undefined
}

function touchCachedResource(cacheKey: string): void {
  db.prepare('UPDATE resource_cache SET last_accessed_at = CURRENT_TIMESTAMP WHERE cache_key = ?').run(cacheKey)
}

function extensionFromContentType(contentType: string | undefined, fallbackUrl: string): string {
  if (contentType === 'image/png') return '.png'
  if (contentType === 'image/webp') return '.webp'
  if (contentType === 'image/gif') return '.gif'
  if (contentType === 'application/json') return '.json'
  if (contentType?.startsWith('text/')) return '.txt'
  const ext = path.extname(safePathname(fallbackUrl)).toLowerCase()
  return ext && ext.length <= 8 ? ext : '.bin'
}

function safePathname(value: string): string {
  try {
    return new URL(value).pathname
  } catch {
    return value
  }
}

function requestCacheIdentity(url: string, method?: string, body?: BodyInit | null): string {
  if (!method || method.toUpperCase() === 'GET') return url
  return `${method.toUpperCase()} ${url} ${bodyToCacheText(body)}`
}

function bodyToCacheText(body?: BodyInit | null): string {
  if (!body) return ''
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof Blob) return `${body.type}:${body.size}`
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('base64')
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer).toString('base64')
  return String(body)
}

function mapResource(row: ResourceCacheRow): CachedResourceRecord {
  return {
    id: row.id,
    cacheKey: row.cache_key,
    source: row.source,
    resourceType: row.resource_type,
    url: row.url,
    filePath: row.file_path,
    contentType: row.content_type ?? undefined,
    sizeBytes: row.size_bytes ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at,
  }
}
