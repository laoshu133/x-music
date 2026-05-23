import crypto from 'node:crypto'
import fs from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { appConfig } from '@/lib/config'
import { EncryptedQQAudioRequiresKeyError } from './decrypt'

interface NpmPackageMetadata {
  'dist-tags'?: {
    latest?: string
  }
  versions?: Record<string, {
    dist?: {
      integrity?: string
      shasum?: string
      tarball?: string
    }
  }>
}

interface UmCryptoModule {
  ready?: Promise<unknown>
  QMC2: new (ekey: string) => {
    decrypt(buffer: Uint8Array, offset: number): void
  }
  detectAudioType?: (buffer: Uint8Array) => { audioType?: string; needMore?: boolean }
}

interface CommonJsModule {
  exports: Record<string, unknown>
}

export interface UmCryptoRefreshResult {
  status: 'up_to_date' | 'installed'
  downloaded: boolean
  path: string
  version: string
}

export interface Qmc2Decryptor {
  decrypt(buffer: Uint8Array, offset: number): void
}

const packageMetadataUrl = 'https://git.um-react.app/api/packages/um/npm/%40unlock-music%2Fcrypto'
const loaderRelativePath = path.join('package', 'dist', 'loader-inline.js')
const packageRoot = () => path.join(appConfig.toolsDir, 'um-crypto')
let loadedModule: Promise<UmCryptoModule> | undefined

export async function refreshUmCrypto(): Promise<UmCryptoRefreshResult> {
  const metadata = await fetchPackageMetadata()
  const version = metadata['dist-tags']?.latest
  const dist = version ? metadata.versions?.[version]?.dist : undefined
  if (!version || !dist?.tarball) {
    throw new Error('UM crypto package metadata does not include a latest tarball')
  }

  const installed = await findBestInstalledUmCrypto()
  if (installed && compareVersions(installed.version, version) >= 0) {
    return {
      status: 'up_to_date',
      downloaded: false,
      path: installed.loaderPath,
      version: installed.version,
    }
  }

  const loaderPath = await installPackage(version, dist)
  loadedModule = undefined
  return {
    status: 'installed',
    downloaded: true,
    path: loaderPath,
    version,
  }
}

export async function resolveUmCryptoLoaderPath(): Promise<string> {
  const installed = await findBestInstalledUmCrypto()
  if (installed) return installed.loaderPath
  return (await refreshUmCrypto()).path
}

export async function createQmc2Decryptor(ekey: string): Promise<Qmc2Decryptor> {
  const module = await loadUmCrypto()
  try {
    return new module.QMC2(ekey)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new EncryptedQQAudioRequiresKeyError(`UM crypto rejected LX ekey: ${detail}`)
  }
}

export async function detectDecryptedAudioExtension(header: Uint8Array): Promise<string | undefined> {
  const module = await loadUmCrypto()
  const result = module.detectAudioType?.(header)
  const audioType = result?.audioType?.toLowerCase()
  if (!audioType || result?.needMore) return undefined
  if (audioType === 'mp4') return '.m4a'
  return `.${audioType}`
}

async function loadUmCrypto(): Promise<UmCryptoModule> {
  loadedModule ??= (async () => {
    const loaderPath = await resolveUmCryptoLoaderPath()
    const module = await loadCommonJsModuleFromFile(loaderPath)
    await module.ready
    if (typeof module.QMC2 !== 'function') throw new Error('UM crypto package does not export QMC2')
    return module
  })()
  return loadedModule
}

async function loadCommonJsModuleFromFile(filePath: string): Promise<UmCryptoModule> {
  const code = await fs.promises.readFile(filePath, 'utf8')
  const module: CommonJsModule = { exports: {} }
  const dirname = path.dirname(filePath)
  const script = new vm.Script(`(function (exports, module, __filename, __dirname) {\n${code}\n})`, {
    filename: filePath,
  })
  const factory = script.runInThisContext() as (
    exports: Record<string, unknown>,
    module: CommonJsModule,
    __filename: string,
    __dirname: string,
  ) => void
  factory(module.exports, module, filePath, dirname)
  return module.exports as unknown as UmCryptoModule
}

async function fetchPackageMetadata(): Promise<NpmPackageMetadata> {
  const response = await fetch(packageMetadataUrl, { cache: 'no-store' })
  if (!response.ok) throw new Error(`UM crypto package lookup failed with ${response.status}`)
  return response.json() as Promise<NpmPackageMetadata>
}

async function installPackage(
  version: string,
  dist: NonNullable<NonNullable<NpmPackageMetadata['versions']>[string]['dist']>,
): Promise<string> {
  const installDir = path.join(packageRoot(), version)
  const loaderPath = path.join(installDir, loaderRelativePath)
  if (await isFile(loaderPath)) return loaderPath

  await rm(installDir, { recursive: true, force: true }).catch(() => undefined)
  await mkdir(installDir, { recursive: true })
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'x-music-um-crypto-'))
  try {
    const tarballUrl = dist.tarball
    if (!tarballUrl) throw new Error(`UM crypto package ${version} does not include a tarball URL`)
    const tarballPath = path.join(tempDir, `crypto-${version}.tgz`)
    await downloadFile(tarballUrl, tarballPath)
    await verifyPackage(tarballPath, dist)
    await extractTarGz(tarballPath, installDir)
    if (!await isFile(loaderPath)) {
      throw new Error(`UM crypto loader was not found in package ${version}`)
    }
    await chmod(loaderPath, 0o644).catch(() => undefined)
    await writeFile(path.join(installDir, 'VERSION'), `${version}\n`)
    return loaderPath
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function findBestInstalledUmCrypto(): Promise<{ version: string; loaderPath: string } | undefined> {
  const entries = await readdir(packageRoot(), { withFileTypes: true }).catch(() => [])
  const installed = (await Promise.all(entries
    .filter(entry => entry.isDirectory())
    .map(async (entry) => {
      const loaderPath = path.join(packageRoot(), entry.name, loaderRelativePath)
      if (!await isFile(loaderPath)) return undefined
      return { version: entry.name, loaderPath }
    })))
    .filter((item): item is { version: string; loaderPath: string } => item !== undefined)

  return installed.sort((left, right) => compareVersions(right.version, left.version))[0]
}

async function downloadFile(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`UM crypto package download failed with ${response.status}`)
  await writeFile(outputPath, Buffer.from(await response.arrayBuffer()))
}

async function verifyPackage(filePath: string, dist: NonNullable<NonNullable<NpmPackageMetadata['versions']>[string]['dist']>): Promise<void> {
  if (dist.integrity?.startsWith('sha512-')) {
    const expected = dist.integrity.slice('sha512-'.length)
    const actual = await hashFile(filePath, 'sha512', 'base64')
    if (actual !== expected) throw new Error('UM crypto package sha512 integrity mismatch')
    return
  }

  if (dist.shasum) {
    const actual = await hashFile(filePath, 'sha1', 'hex')
    if (actual !== dist.shasum) throw new Error('UM crypto package shasum mismatch')
  }
}

async function hashFile(filePath: string, algorithm: string, encoding: crypto.BinaryToTextEncoding): Promise<string> {
  const hash = crypto.createHash(algorithm)
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk)
  }
  return hash.digest(encoding)
}

async function extractTarGz(archivePath: string, outputDir: string): Promise<void> {
  const tarProcess = await import('node:child_process')
  await new Promise<void>((resolve, reject) => {
    const child = tarProcess.spawn('tar', ['-xzf', archivePath, '-C', outputDir])
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`)))
  })
}

async function isFile(filePath: string): Promise<boolean> {
  const file = await stat(filePath).catch(() => undefined)
  return Boolean(file?.isFile())
}

function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left)
  const rightParts = versionParts(right)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0
    const rightValue = rightParts[index] ?? 0
    if (leftValue !== rightValue) return leftValue - rightValue
  }

  return left.localeCompare(right)
}

function versionParts(version: string): number[] {
  return version
    .replace(/^v/i, '')
    .split(/[.-]/)
    .map(part => Number(part))
    .filter(part => Number.isFinite(part))
}
