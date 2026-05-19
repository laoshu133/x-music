import crypto from 'node:crypto'
import fs from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { appConfig } from '@/lib/config'
import { enqueueTagJob, fileExtensionFromContentType, upsertTrackFileStatus } from '@/lib/cache/store'
import { triggerInlineTagging } from '@/lib/tagging/inline'
import type { MusicQuality, TrackRecord } from '@/lib/types'

interface TeeResult {
  response: Response
  completion: Promise<void>
}

export const streamLocalFile = async (filePath: string, request: Request): Promise<Response> => {
  const fileStat = await stat(filePath)
  const range = request.headers.get('range')
  const contentType = contentTypeFromPath(filePath)

  if (!range) {
    return new Response(Readable.toWeb(fs.createReadStream(filePath)) as BodyInit, {
      status: 200,
      headers: {
        'content-type': contentType,
        'content-length': String(fileStat.size),
        'accept-ranges': 'bytes',
      },
    })
  }

  const parsedRange = parseRange(range, fileStat.size)
  if (!parsedRange) {
    return new Response(null, {
      status: 416,
      headers: {
        'content-range': `bytes */${fileStat.size}`,
        'accept-ranges': 'bytes',
      },
    })
  }

  const { start, end } = parsedRange
  return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })) as BodyInit, {
    status: 206,
    headers: {
      'content-type': contentType,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${fileStat.size}`,
      'accept-ranges': 'bytes',
    },
  })
}

export const createUpstreamTeeResponse = async (
  upstreamUrl: string,
  track: TrackRecord,
  quality: MusicQuality,
  request: Request,
): Promise<TeeResult> => {
  await mkdir(appConfig.stagingDir, { recursive: true })
  await mkdir(appConfig.inboxDir, { recursive: true })

  const upstreamHeaders = new Headers({
    'user-agent': 'Mozilla/5.0 miXmusic/1.0',
    accept: '*/*',
  })

  const range = request.headers.get('range')
  if (range) upstreamHeaders.set('range', range)

  const upstream = await fetch(upstreamUrl, {
    headers: upstreamHeaders,
    cache: 'no-store',
  })

  if (!upstream.ok && upstream.status !== 206) {
    throw new Error(`upstream returned ${upstream.status}`)
  }

  if (!upstream.body) {
    throw new Error('upstream did not return a readable body')
  }

  const extension = fileExtensionFromContentType(upstream.headers.get('content-type'), upstreamUrl)
  const cacheKey = `${track.source}-${safeFilePart(track.songmid)}-${quality}-${Date.now()}`
  const partPath = path.join(appConfig.stagingDir, `${cacheKey}.part`)
  const inboxPath = path.join(appConfig.inboxDir, `${cacheKey}${extension}`)
  const shouldCache = !range || range.startsWith('bytes=0-')

  const trackFile = upsertTrackFileStatus(track.id, quality, 'streaming_and_caching', {
    rawPath: shouldCache ? partPath : undefined,
    error: shouldCache ? undefined : 'Partial first-play range is not cached',
  })

  const { body, completion } = teeUpstreamToClientAndCache({
    upstreamBody: upstream.body,
    partPath,
    inboxPath,
    shouldCache,
    track,
    quality,
  })
  const headers = buildProxyHeaders(upstream.headers, shouldCache)
  return {
    response: new Response(body, {
      status: upstream.status,
      headers,
    }),
    completion,
  }
}

const teeUpstreamToClientAndCache = ({
  upstreamBody,
  partPath,
  inboxPath,
  shouldCache,
  track,
  quality,
}: {
  upstreamBody: ReadableStream<Uint8Array>
  partPath: string
  inboxPath: string
  shouldCache: boolean
  track: TrackRecord
  quality: MusicQuality
}): { body: ReadableStream<Uint8Array>; completion: Promise<void> } => {
  const reader = upstreamBody.getReader()
  const hash = crypto.createHash('sha256')
  const writeStream = shouldCache ? fs.createWriteStream(partPath) : undefined
  let clientCancelled = false
  let writtenBytes = 0
  let writeFailed: Error | undefined
  let resolveCompletion: () => void
  let rejectCompletion: (error: unknown) => void

  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })

  writeStream?.on('error', (error) => {
    writeFailed = error
  })

  const completeCache = async (): Promise<void> => {
    try {
      if (!writeStream || !shouldCache) {
        resolveCompletion()
        return
      }

      writeStream.end()
      await waitForWritable(writeStream)
      if (writeFailed) throw writeFailed

      await rename(partPath, inboxPath)
      const completedFile = upsertTrackFileStatus(track.id, quality, 'tagging', {
        rawPath: inboxPath,
        finalPath: inboxPath,
        sizeBytes: writtenBytes,
        sha256: hash.digest('hex'),
      })
      enqueueTagJob(completedFile, track)
      triggerInlineTagging()
      resolveCompletion()
    } catch (error) {
      await unlink(partPath).catch(() => undefined)
      upsertTrackFileStatus(track.id, quality, 'failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      rejectCompletion(error)
    }
  }

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break

          if (writeStream && !writeFailed) {
            const buffer = Buffer.from(value)
            writtenBytes += buffer.length
            hash.update(buffer)
            writeStream.write(buffer)
          }

          if (!clientCancelled) {
            controller.enqueue(value)
          }
        }

        if (!clientCancelled) controller.close()
        await completeCache()
      } catch (error) {
        writeStream?.destroy()
        await unlink(partPath).catch(() => undefined)
        upsertTrackFileStatus(track.id, quality, 'failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        if (!clientCancelled) controller.error(error)
        rejectCompletion(error)
      }
    },
    cancel() {
      clientCancelled = true
      // Keep reading the same upstream in start() so the cache can still complete.
    },
  })

  return { body, completion }
}

const buildProxyHeaders = (upstreamHeaders: Headers, cachingFullFile: boolean): Headers => {
  const headers = new Headers()
  const passthrough = ['content-type', 'content-length', 'content-range', 'etag', 'last-modified']

  for (const key of passthrough) {
    const value = upstreamHeaders.get(key)
    if (value) headers.set(key, value)
  }

  headers.set('accept-ranges', cachingFullFile ? 'none' : (upstreamHeaders.get('accept-ranges') ?? 'bytes'))
  headers.set('cache-control', 'no-store')
  return headers
}

const parseRange = (range: string, size: number): { start: number; end: number } | undefined => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range)
  if (!match) return undefined

  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return undefined

  if (!rawStart) {
    const suffixLength = Number(rawEnd)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return undefined
    const start = Math.max(size - suffixLength, 0)
    return { start, end: size - 1 }
  }

  const start = Number(rawStart)
  const end = rawEnd ? Number(rawEnd) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return undefined
  return { start, end: Math.min(end, size - 1) }
}

const contentTypeFromPath = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.flac') return 'audio/flac'
  if (ext === '.m4a' || ext === '.mp4') return 'audio/mp4'
  if (ext === '.ogg') return 'audio/ogg'
  return 'audio/mpeg'
}

const waitForWritable = async (stream: fs.WriteStream): Promise<void> => {
  if (stream.closed) return
  await new Promise<void>((resolve, reject) => {
    stream.once('finish', resolve)
    stream.once('error', reject)
  })
}

const safeFilePart = (value: string): string => {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
}
