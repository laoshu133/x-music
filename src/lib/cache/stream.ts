import crypto from 'node:crypto'
import fs from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { appConfig } from '@/lib/config'
import { enqueueTagJob, fileExtensionFromContentType, isPlayableAudioFileName, upsertTrackFileStatus } from '@/lib/cache/store'
import { enqueueEmbyTrackSync } from '@/lib/emby/sync'
import { triggerInlineTagging } from '@/lib/tagging/inline'
import type { MusicInfo, MusicQuality, TrackRecord } from '@/lib/types'
import { isEncryptedQQAudioFileName } from './decrypt'
import { createQmc2Decryptor, detectDecryptedAudioExtension } from './um-crypto'

interface TeeResult {
  response: Response
  completion: Promise<void>
}

interface EncryptedTeeResult {
  body: ReadableStream<Uint8Array>
  completion: Promise<void>
  contentType: Promise<string>
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
  ekey?: string,
): Promise<TeeResult> => {
  await mkdir(appConfig.stagingDir, { recursive: true })
  await mkdir(appConfig.inboxDir, { recursive: true })

  const upstreamHeaders = new Headers({
    'user-agent': 'Mozilla/5.0 XMusic/1.0',
    accept: '*/*',
  })

  const encryptedUpstream = isEncryptedQQAudioFileName(upstreamUrl)
  const range = request.headers.get('range')
  if (range && !encryptedUpstream) upstreamHeaders.set('range', range)

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
  if (encryptedUpstream) {
    if (upstream.status === 206) throw new Error('encrypted upstream returned partial content')
    if (!ekey) return createPossiblyPlainEncryptedUpstreamResponse({
      upstreamBody: upstream.body,
      fallbackExtension: extension,
      track,
      quality,
    })
    return createEncryptedUpstreamResponse({
      upstreamBody: upstream.body,
      track,
      quality,
      ekey,
    })
  }
  if (!isPlayableAudioFileName(extension)) {
    throw new Error(`upstream returned unsupported audio container: ${extension}`)
  }
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
  const headers = buildProxyHeaders(upstream.headers, shouldCache, upstreamUrl)
  return {
    response: new Response(body, {
      status: upstream.status,
      headers,
    }),
    completion,
  }
}

async function createEncryptedUpstreamResponse({
  upstreamBody,
  track,
  quality,
  ekey,
}: {
  upstreamBody: ReadableStream<Uint8Array>
  track: TrackRecord
  quality: MusicQuality
  ekey: string
}): Promise<TeeResult> {
  const cacheKey = `${track.source}-${safeFilePart(track.songmid)}-${quality}-${Date.now()}`
  const partPath = path.join(appConfig.stagingDir, `${cacheKey}.part`)
  upsertTrackFileStatus(track.id, quality, 'streaming_and_caching', {
    rawPath: partPath,
  })

  const decryptor = await createQmc2Decryptor(ekey)
  const { body, completion, contentType } = teeEncryptedUpstreamToClientAndCache({
    upstreamBody,
    partPath,
    cacheKey,
    track,
    quality,
    decryptor,
  })
  return {
    response: new Response(body, {
      status: 200,
      headers: {
        'content-type': await contentType,
        'cache-control': 'no-store',
        'accept-ranges': 'none',
      },
    }),
    completion,
  }
}

async function createPossiblyPlainEncryptedUpstreamResponse({
  upstreamBody,
  fallbackExtension,
  track,
  quality,
}: {
  upstreamBody: ReadableStream<Uint8Array>
  fallbackExtension: string
  track: TrackRecord
  quality: MusicQuality
}): Promise<TeeResult> {
  const cacheKey = `${track.source}-${safeFilePart(track.songmid)}-${quality}-${Date.now()}`
  const partPath = path.join(appConfig.stagingDir, `${cacheKey}.part`)
  const reader = upstreamBody.getReader()
  const initial = await readInitialPlainChunks(reader)
  const extension = initial.extension ?? fallbackExtension
  const inboxPath = path.join(appConfig.inboxDir, `${cacheKey}${extension}`)
  upsertTrackFileStatus(track.id, quality, 'streaming_and_caching', {
    rawPath: partPath,
  })

  const { body, completion } = teeUpstreamToClientAndCache({
    reader,
    initialChunks: initial.chunks,
    partPath,
    inboxPath,
    shouldCache: true,
    track,
    quality,
  })

  return {
    response: new Response(body, {
      status: 200,
      headers: {
        'content-type': contentTypeFromPath(extension),
        'cache-control': 'no-store',
        'accept-ranges': 'none',
      },
    }),
    completion,
  }
}

const teeUpstreamToClientAndCache = ({
  upstreamBody,
  reader: providedReader,
  initialChunks = [],
  partPath,
  inboxPath,
  shouldCache,
  track,
  quality,
}: {
  upstreamBody?: ReadableStream<Uint8Array>
  reader?: ReadableStreamDefaultReader<Uint8Array>
  initialChunks?: Uint8Array[]
  partPath: string
  inboxPath: string
  shouldCache: boolean
  track: TrackRecord
  quality: MusicQuality
}): { body: ReadableStream<Uint8Array>; completion: Promise<void> } => {
  const reader = providedReader ?? upstreamBody?.getReader()
  if (!reader) throw new Error('upstream reader was not provided')
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
      enqueueEmbyTrackSync({
        source: track.source,
        songmid: track.songmid,
        musicInfo: trackToMusicInfo(track),
      })
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
        for (const value of initialChunks) {
          if (writeStream && !writeFailed) {
            const buffer = Buffer.from(value)
            writtenBytes += buffer.length
            hash.update(buffer)
            if (!writeStream.write(buffer)) await waitForWritableDrain(writeStream)
          }

          if (!clientCancelled) {
            controller.enqueue(value)
          }
        }

        for (;;) {
          const { done, value } = await reader.read()
          if (done) break

          if (writeStream && !writeFailed) {
            const buffer = Buffer.from(value)
            writtenBytes += buffer.length
            hash.update(buffer)
            if (!writeStream.write(buffer)) await waitForWritableDrain(writeStream)
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

const teeEncryptedUpstreamToClientAndCache = ({
  upstreamBody,
  partPath,
  cacheKey,
  track,
  quality,
  decryptor,
}: {
  upstreamBody: ReadableStream<Uint8Array>
  partPath: string
  cacheKey: string
  track: TrackRecord
  quality: MusicQuality
  decryptor: { decrypt(buffer: Uint8Array, offset: number): void }
}): EncryptedTeeResult => {
  const reader = upstreamBody.getReader()
  const hash = crypto.createHash('sha256')
  const writeStream = fs.createWriteStream(partPath)
  const headerChunks: Buffer[] = []
  const queuedChunks: Buffer[] = []
  let clientCancelled = false
  let offset = 0
  let writtenBytes = 0
  let writeFailed: Error | undefined
  let finalExtension: string | undefined
  let finalized = false
  let resolveCompletion: () => void
  let rejectCompletion: (error: unknown) => void
  let resolveContentType: (contentType: string) => void
  let rejectContentType: (error: unknown) => void

  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })
  const contentType = new Promise<string>((resolve, reject) => {
    resolveContentType = resolve
    rejectContentType = reject
  })

  writeStream.on('error', (error) => {
    writeFailed = error
  })

  const completeCache = async (): Promise<void> => {
    try {
      writeStream.end()
      await waitForWritable(writeStream)
      if (writeFailed) throw writeFailed

      const extension = finalExtension ?? '.mp3'
      const inboxPath = path.join(appConfig.inboxDir, `${cacheKey}${extension}`)
      await rename(partPath, inboxPath)
      const completedFile = upsertTrackFileStatus(track.id, quality, 'tagging', {
        rawPath: inboxPath,
        finalPath: inboxPath,
        sizeBytes: writtenBytes,
        sha256: hash.digest('hex'),
      })
      enqueueTagJob(completedFile, track)
      enqueueEmbyTrackSync({
        source: track.source,
        songmid: track.songmid,
        musicInfo: trackToMusicInfo(track),
      })
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
      const flushQueuedChunks = () => {
        if (clientCancelled) return
        for (const chunk of queuedChunks.splice(0)) {
          controller.enqueue(chunk)
        }
      }

      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break

          const buffer = Buffer.from(value)
          decryptor.decrypt(buffer, offset)
          offset += buffer.length

          if (!finalized) {
            headerChunks.push(buffer)
            const header = Buffer.concat(headerChunks)
            finalExtension = await detectDecryptedAudioExtension(header)
            finalized = finalExtension !== undefined || header.length >= 8192
            if (finalized) {
              resolveContentType(contentTypeFromPath(finalExtension ?? '.mp3'))
              flushQueuedChunks()
            }
          }

          writtenBytes += buffer.length
          hash.update(buffer)
          if (!writeStream.write(buffer)) await waitForWritableDrain(writeStream)
          if (writeFailed) throw writeFailed

          if (!finalized) {
            queuedChunks.push(buffer)
          } else if (!clientCancelled) {
            controller.enqueue(buffer)
          }
        }

        if (!finalized) {
          finalExtension = '.mp3'
          finalized = true
          resolveContentType(contentTypeFromPath(finalExtension))
          flushQueuedChunks()
        }

        if (!clientCancelled) controller.close()
        await completeCache()
      } catch (error) {
        writeStream.destroy()
        await unlink(partPath).catch(() => undefined)
        upsertTrackFileStatus(track.id, quality, 'failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        rejectContentType(error)
        if (!clientCancelled) controller.error(error)
        rejectCompletion(error)
      }
    },
    cancel() {
      clientCancelled = true
      // Keep reading the same upstream in start() so the decrypted cache can still complete.
    },
  })

  return { body, completion, contentType }
}

const buildProxyHeaders = (upstreamHeaders: Headers, cachingFullFile: boolean, upstreamUrl: string): Headers => {
  const headers = new Headers()
  const passthrough = ['content-type', 'content-length', 'content-range', 'etag', 'last-modified']

  for (const key of passthrough) {
    const value = upstreamHeaders.get(key)
    if (value) headers.set(key, value)
  }

  const contentType = headers.get('content-type')
  if (!contentType || contentType === 'application/octet-stream') {
    headers.set('content-type', fileContentTypeFromUrl(upstreamUrl))
  }

  headers.set('accept-ranges', cachingFullFile ? 'none' : (upstreamHeaders.get('accept-ranges') ?? 'bytes'))
  headers.set('cache-control', 'no-store')
  return headers
}

const fileContentTypeFromUrl = (value: string): string => {
  try {
    return contentTypeFromPath(new URL(value).pathname)
  } catch {
    return contentTypeFromPath(value)
  }
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
  const ext = filePath.startsWith('.') && !filePath.includes('/')
    ? filePath.toLowerCase()
    : path.extname(filePath).toLowerCase()
  if (ext === '.flac' || ext === '.mflac') return 'audio/flac'
  if (ext === '.m4a' || ext === '.mp4') return 'audio/mp4'
  if (ext === '.ogg' || ext === '.mgg') return 'audio/ogg'
  if (ext === '.wav') return 'audio/wav'
  return 'audio/mpeg'
}

async function readInitialPlainChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ chunks: Uint8Array[]; extension?: string }> {
  const chunks: Uint8Array[] = []
  let header = Buffer.alloc(0)

  while (header.length < 8192) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    header = Buffer.concat([header, Buffer.from(value)])
    const extension = detectAudioExtensionFromHeader(header)
    if (extension) return { chunks, extension }
  }

  return { chunks, extension: detectAudioExtensionFromHeader(header) }
}

function detectAudioExtensionFromHeader(header: Buffer): string | undefined {
  if (header.length >= 4 && header.subarray(0, 4).equals(Buffer.from('fLaC'))) return '.flac'
  if (header.length >= 3 && header.subarray(0, 3).equals(Buffer.from('ID3'))) return '.mp3'
  if (header.length >= 2 && header[0] === 0xff && (header[1] & 0xe0) === 0xe0) return '.mp3'
  if (header.length >= 4 && header.subarray(0, 4).equals(Buffer.from('OggS'))) return '.ogg'
  if (header.length >= 12 && header.subarray(0, 4).equals(Buffer.from('RIFF')) && header.subarray(8, 12).equals(Buffer.from('WAVE'))) return '.wav'
  if (header.length >= 12 && header.subarray(4, 8).equals(Buffer.from('ftyp'))) return '.m4a'
  return undefined
}

function trackToMusicInfo(track: TrackRecord): MusicInfo {
  return {
    source: track.source,
    songmid: track.songmid,
    name: track.name,
    singer: track.singer,
    albumName: track.albumName,
    albumId: track.albumId,
    interval: track.interval,
    img: track.imageUrl,
  }
}

const waitForWritable = async (stream: fs.WriteStream): Promise<void> => {
  if (stream.closed) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      stream.off('finish', onFinish)
      stream.off('error', onError)
    }
    const onFinish = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    stream.once('finish', onFinish)
    stream.once('error', onError)
  })
}

const waitForWritableDrain = async (stream: fs.WriteStream): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      stream.off('drain', onDrain)
      stream.off('error', onError)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    stream.once('drain', onDrain)
    stream.once('error', onError)
  })
}

const safeFilePart = (value: string): string => {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
}

const safeUrlPathname = (value: string): string => {
  try {
    return new URL(value).pathname
  } catch {
    return value
  }
}
