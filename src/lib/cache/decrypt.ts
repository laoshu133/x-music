import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { execFile, type ExecFileException } from 'node:child_process'
import { promisify } from 'node:util'
import { isPlayableAudioFileName } from './store'
import { appConfig } from '@/lib/config'
import { resolveUmCliPath } from './um-cli'

const execFileAsync = promisify(execFile)
const encryptedQQAudioExtensions = new Set(['.mgg', '.mflac'])
export const encryptedQQAudioRequiresKeyMessage = 'QQ encrypted audio requires a matching QQ Music local key; no decryptable or non-encrypted URL was available.'

export class EncryptedQQAudioRequiresKeyError extends Error {
  constructor(detail: string) {
    super(`QQ encrypted audio requires a matching QQ Music local key; UM could not decrypt this .mgg/.mflac file. ${detail}`)
    this.name = 'EncryptedQQAudioRequiresKeyError'
  }
}

export interface DecryptedAudioFile {
  finalPath: string
  extension: string
  sizeBytes: number
}

export interface DecryptEncryptedQQAudioOptions {
  ekey?: string
}

export function isEncryptedQQAudioFileName(filePath: string): boolean {
  return encryptedQQAudioExtensions.has(path.extname(safeUrlPathname(filePath)).toLowerCase())
}

export function isEncryptedQQAudioRequiresKeyError(error: unknown): boolean {
  return error instanceof EncryptedQQAudioRequiresKeyError
    || (error instanceof Error && error.message.includes('QQ encrypted audio requires a matching QQ Music local key'))
}

export async function decryptEncryptedQQAudioFile(inputPath: string, options: DecryptEncryptedQQAudioOptions = {}): Promise<DecryptedAudioFile> {
  if (!isEncryptedQQAudioFileName(inputPath)) {
    const sizeBytes = (await stat(inputPath)).size
    return {
      finalPath: inputPath,
      extension: path.extname(inputPath).toLowerCase(),
      sizeBytes,
    }
  }

  const cliPath = await resolveUmCliPath()
  if (options.ekey) {
    await appendQTagFooter(inputPath, options.ekey)
  }

  const outputDir = path.join(appConfig.inboxDir, `um-${randomUUID()}`)
  await mkdir(outputDir, { recursive: true })
  try {
    await execFileAsync(cliPath, ['--overwrite', '--output', outputDir, inputPath], {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    }).catch((error: unknown) => {
      const detail = formatExecError(error)
      if (isQmcMissingKeyError(detail)) {
        throw new EncryptedQQAudioRequiresKeyError(detail)
      }
      throw new Error(`UM CLI decrypt failed: ${detail}`)
    })

    const output = await findDecryptedOutput(outputDir)
    await unlink(inputPath).catch(() => undefined)
    return output
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function appendQTagFooter(inputPath: string, ekey: string): Promise<void> {
  const payload = Buffer.from(`${ekey},0,2`, 'utf8')
  const footer = Buffer.alloc(payload.length + 8)
  payload.copy(footer, 0)
  footer.writeUInt32BE(payload.length, payload.length)
  footer.write('QTag', payload.length + 4, 'ascii')
  await appendFile(inputPath, footer)
}

async function findDecryptedOutput(directory: string): Promise<DecryptedAudioFile> {
  const files = (await listFiles(directory))
    .filter(filePath => isPlayableAudioFileName(filePath))

  if (files.length !== 1) {
    throw new Error(`UM CLI produced ${files.length} playable files`)
  }

  const finalPath = files[0]
  const sizeBytes = (await stat(finalPath)).size
  return {
    finalPath,
    extension: path.extname(finalPath).toLowerCase(),
    sizeBytes,
  }
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return listFiles(entryPath)
    return entry.isFile() ? [entryPath] : []
  }))
  return nested.flat()
}

function safeUrlPathname(value: string): string {
  try {
    return new URL(value).pathname
  } catch {
    return value
  }
}

function formatExecError(error: unknown): string {
  if (!isExecFileException(error)) return error instanceof Error ? error.message : String(error)

  const detail = [
    error.message,
    tailText(error.stdout, 'stdout'),
    tailText(error.stderr, 'stderr'),
  ].filter(Boolean)
  return detail.join('; ')
}

function isExecFileException(error: unknown): error is ExecFileException & { stdout?: string | Buffer; stderr?: string | Buffer } {
  return error instanceof Error
}

function tailText(value: string | Buffer | undefined, label: string): string | undefined {
  if (!value) return undefined
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : value
  const trimmed = text.trim()
  if (!trimmed) return undefined
  return `${label}: ${trimmed.slice(-2000)}`
}

function isQmcMissingKeyError(value: string): boolean {
  return value.includes('qmc: detect file type failed')
    || value.includes('no any decoder can resolve the file')
    || value.includes('searchKey: no key found')
}
