import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { appConfig } from '@/lib/config'
import type { TagTrackFileJobPayload } from '@/lib/tagging/types'

export type TaggingMode = 'http-api' | 'shared-directory'

export interface TaggingResult {
  mode: TaggingMode
  finalPath: string
}

export interface TaggingProvider {
  tagFile(payload: TagTrackFileJobPayload): Promise<TaggingResult>
}

interface MusicTagWebProbeResult {
  available: boolean
  endpoint?: string
  error?: string
}

interface CandidateFile {
  path: string
  name: string
  size: number
  modifiedMs: number
}

const audioExtensions = new Set([
  '.aac',
  '.ape',
  '.flac',
  '.m4a',
  '.mp3',
  '.ogg',
  '.opus',
  '.wav',
  '.wma',
])

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const taggingEnv = z.object({
  MUSIC_TAG_WEB_API_URL: z.string().url().optional(),
  TAGGING_POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  TAGGING_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
}).parse(process.env)

const normalizeToken = (value: string | undefined): string => (
  value ?? ''
).toLowerCase().replace(/[\W_]+/g, '')

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function collectAudioFiles(root: string): Promise<CandidateFile[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) return collectAudioFiles(entryPath)
    if (!entry.isFile() || !audioExtensions.has(path.extname(entry.name).toLowerCase())) {
      return []
    }

    const stat = await fs.stat(entryPath)
    return [{
      path: entryPath,
      name: entry.name,
      size: stat.size,
      modifiedMs: stat.mtimeMs,
    }]
  }))

  return files.flat()
}

function scoreCandidate(candidate: CandidateFile, payload: TagTrackFileJobPayload, rawSize: number): number {
  const candidateName = normalizeToken(candidate.name)
  const title = normalizeToken(payload.title)
  const artist = normalizeToken(payload.artist)
  const songmid = normalizeToken(payload.songmid)

  let score = 0
  if (title && candidateName.includes(title)) score += 4
  if (artist && candidateName.includes(artist)) score += 2
  if (songmid && candidateName.includes(songmid)) score += 2
  if (candidate.size === rawSize) score += 4
  if (Math.abs(candidate.size - rawSize) <= Math.max(1024 * 64, rawSize * 0.01)) score += 2
  if (candidate.modifiedMs >= Date.now() - taggingEnv.TAGGING_POLL_TIMEOUT_MS - 60000) score += 1

  return score
}

async function probeMusicTagWebApi(baseUrl: string): Promise<MusicTagWebProbeResult> {
  const endpoints = ['/api/health', '/api/version', '/health']

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(new URL(endpoint, baseUrl), { method: 'GET' })
      if (response.ok) return { available: true, endpoint }
    } catch (error) {
      return {
        available: false,
        endpoint,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return { available: false }
}

async function submitToMusicTagWebApi(
  baseUrl: string,
  payload: TagTrackFileJobPayload,
): Promise<TaggingResult | null> {
  const probe = await probeMusicTagWebApi(baseUrl)
  if (!probe.available) return null

  const response = await fetch(new URL('/api/tasks/tag', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filePath: payload.rawPath,
      outputDir: appConfig.musicDir,
      metadata: {
        title: payload.title,
        artist: payload.artist,
        album: payload.album,
        albumId: payload.albumId,
        source: payload.source,
        songmid: payload.songmid,
        quality: payload.quality,
      },
    }),
  }).catch(() => null)

  if (!response?.ok) return null

  const data = await response.json().catch(() => undefined) as { finalPath?: string } | undefined
  if (!data?.finalPath) return null

  return {
    mode: 'http-api',
    finalPath: data.finalPath,
  }
}

async function waitForSharedDirectoryResult(payload: TagTrackFileJobPayload): Promise<TaggingResult> {
  const deadline = Date.now() + taggingEnv.TAGGING_POLL_TIMEOUT_MS
  const rawStat = await fs.stat(payload.rawPath)

  while (Date.now() < deadline) {
    const candidates = await collectAudioFiles(appConfig.musicDir)
    const best = candidates
      .map((candidate) => ({
        candidate,
        score: scoreCandidate(candidate, payload, rawStat.size),
      }))
      .filter(({ candidate }) => path.resolve(candidate.path) !== path.resolve(payload.rawPath))
      .sort((left, right) => right.score - left.score)[0]

    if (best && best.score >= 4 && await pathExists(best.candidate.path)) {
      return {
        mode: 'shared-directory',
        finalPath: best.candidate.path,
      }
    }

    await sleep(taggingEnv.TAGGING_POLL_INTERVAL_MS)
  }

  throw new Error(`Tagged file not found in ${appConfig.musicDir}`)
}

export function createTaggingProvider(): TaggingProvider {
  return {
    async tagFile(payload) {
      if (!await pathExists(payload.rawPath)) {
        throw new Error(`Inbox file does not exist: ${payload.rawPath}`)
      }

      if (taggingEnv.MUSIC_TAG_WEB_API_URL) {
        const apiResult = await submitToMusicTagWebApi(taggingEnv.MUSIC_TAG_WEB_API_URL, payload)
        if (apiResult) return apiResult
      }

      return waitForSharedDirectoryResult(payload)
    },
  }
}
