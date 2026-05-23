import crypto from 'node:crypto'
import fs from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appConfig } from '@/lib/config'

interface ReleaseAsset {
  name?: string
  browser_download_url?: string
}

interface ReleasePayload {
  tag_name?: string
  assets?: ReleaseAsset[]
}

export interface UmCliRefreshResult {
  status: 'up_to_date' | 'installed'
  downloaded: boolean
  path: string
  tagName?: string
}

const latestReleaseUrl = 'https://git.um-react.app/api/v1/repos/um/cli/releases/latest'

export async function resolveUmCliPath(): Promise<string> {
  return (await refreshUmCli()).path
}

export async function refreshUmCli(): Promise<UmCliRefreshResult> {
  const release = await fetchLatestRelease()
  const asset = findPlatformAsset(release)
  const shaAsset = release.assets?.find(item => item.name === 'sha256sum.txt')
  const tagName = release.tag_name
  if (!tagName || !asset.name || !asset.browser_download_url) {
    throw new Error('UM CLI latest release does not include a compatible asset')
  }
  const installAsset = {
    ...asset,
    name: asset.name,
    browser_download_url: asset.browser_download_url,
  }

  const installed = await findBestInstalledUmCli()
  if (installed && compareReleaseTags(installed.tagName, tagName) >= 0) {
    return {
      status: 'up_to_date',
      downloaded: false,
      path: installed.executablePath,
      tagName: installed.tagName,
    }
  }

  const executablePath = await installRelease({ ...release, tag_name: tagName }, installAsset, shaAsset)
  return {
    status: 'installed',
    downloaded: true,
    path: executablePath,
    tagName: release.tag_name,
  }
}

async function installRelease(
  release: ReleasePayload & { tag_name: string },
  asset: ReleaseAsset & { name: string; browser_download_url: string },
  shaAsset?: ReleaseAsset,
): Promise<string> {
  const installDir = path.join(appConfig.toolsDir, 'um', release.tag_name)
  const executablePath = path.join(installDir, process.platform === 'win32' ? 'um.exe' : 'um')
  if (await isExecutableFile(executablePath)) return executablePath

  await rm(installDir, { recursive: true, force: true }).catch(() => undefined)
  await mkdir(installDir, { recursive: true })
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'x-music-um-'))
  try {
    const archivePath = path.join(tempDir, asset.name)
    await downloadFile(asset.browser_download_url, archivePath)

    if (shaAsset?.browser_download_url) {
      const sumsPath = path.join(tempDir, 'sha256sum.txt')
      await downloadFile(shaAsset.browser_download_url, sumsPath)
      await verifySha256File(archivePath, asset.name, sumsPath)
    }

    await extractArchive(archivePath, installDir)
    if (!await isExecutableFile(executablePath)) {
      throw new Error(`UM CLI executable was not found in ${asset.name}`)
    }
    await chmod(executablePath, 0o755).catch(() => undefined)
    return executablePath
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function findBestInstalledUmCli(): Promise<{ tagName: string; executablePath: string } | undefined> {
  const root = path.join(appConfig.toolsDir, 'um')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const installed = (await Promise.all(entries
    .filter(entry => entry.isDirectory())
    .map(async (entry) => {
      const executablePath = path.join(root, entry.name, process.platform === 'win32' ? 'um.exe' : 'um')
      if (!await isExecutableFile(executablePath)) return undefined
      return { tagName: entry.name, executablePath }
    })))
    .filter((item): item is { tagName: string; executablePath: string } => item !== undefined)

  return installed.sort((left, right) => compareReleaseTags(right.tagName, left.tagName))[0]
}

async function fetchLatestRelease(): Promise<ReleasePayload> {
  const response = await fetch(latestReleaseUrl, { cache: 'no-store' })
  if (!response.ok) throw new Error(`UM CLI release lookup failed with ${response.status}`)
  return response.json() as Promise<ReleasePayload>
}

function findPlatformAsset(release: ReleasePayload): ReleaseAsset {
  const platform = process.platform === 'darwin'
    ? 'darwin'
    : process.platform === 'linux'
      ? 'linux'
      : process.platform === 'win32'
        ? 'windows'
        : undefined
  const arch = process.arch === 'x64'
    ? 'amd64'
    : process.arch === 'arm64'
      ? 'arm64'
      : undefined
  if (!platform || !arch) throw new Error(`UM CLI is not available for ${process.platform}/${process.arch}`)
  const suffix = process.platform === 'win32' ? '.zip' : '.tar.gz'
  const escapedSuffix = suffix.replaceAll('.', '\\.')
  const pattern = new RegExp(`^um-${platform}-${arch}-.+${escapedSuffix}$`)
  const asset = release.assets?.find(item => item.name && pattern.test(item.name))
  if (!asset) throw new Error(`UM CLI release has no asset for ${platform}/${arch}`)
  return asset
}

async function downloadFile(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`UM CLI download failed with ${response.status}`)
  await fs.promises.writeFile(outputPath, Buffer.from(await response.arrayBuffer()))
}

async function verifySha256File(filePath: string, fileName: string, sumsPath: string): Promise<void> {
  const text = await readFile(sumsPath, 'utf8')
  const line = text.split(/\r?\n/).find(item => item.includes(fileName))
  const expected = line?.match(/^[a-fA-F0-9]{64}/)?.[0]?.toLowerCase()
  if (!expected) throw new Error(`UM CLI sha256 entry missing for ${fileName}`)
  const actual = await sha256File(filePath)
  if (actual !== expected) throw new Error(`UM CLI sha256 mismatch for ${fileName}`)
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

async function extractArchive(archivePath: string, outputDir: string): Promise<void> {
  if (archivePath.endsWith('.tar.gz')) {
    await extractTarGz(archivePath, outputDir)
    return
  }
  throw new Error('UM CLI zip release extraction is not implemented on this platform')
}

async function extractTarGz(archivePath: string, outputDir: string): Promise<void> {
  const tarProcess = await import('node:child_process')
  await new Promise<void>((resolve, reject) => {
    const child = tarProcess.spawn('tar', ['-xzf', archivePath, '-C', outputDir])
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`)))
  })
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  const file = await stat(filePath).catch(() => undefined)
  return Boolean(file?.isFile())
}

function compareReleaseTags(left: string, right: string): number {
  const leftParts = releaseTagParts(left)
  const rightParts = releaseTagParts(right)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0
    const rightValue = rightParts[index] ?? 0
    if (leftValue !== rightValue) return leftValue - rightValue
  }

  return left.localeCompare(right)
}

function releaseTagParts(tagName: string): number[] {
  return tagName
    .replace(/^v/i, '')
    .split(/[.-]/)
    .map(part => Number(part))
    .filter(part => Number.isFinite(part))
}
