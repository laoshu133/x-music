import '../src/lib/config'
import { db } from '../src/lib/db'
import { embyAuthorizationHeader } from '../src/lib/emby/auth'

interface EmbyItem {
  Id?: string
  Name?: string
  Album?: string
  Artists?: string[]
  Path?: string
  Container?: string
  Size?: number
  MediaSources?: Array<{
    Path?: string
    Container?: string
    Size?: number
    MediaStreams?: Array<{
      Type?: string
      Codec?: string
      BitRate?: number
    }>
  }>
}

interface DuplicateGroup {
  key: string
  keep: ScoredItem
  remove: ScoredItem[]
}

interface ScoredItem {
  item: EmbyItem
  score: number
}

const args = new Set(process.argv.slice(2))
const apply = args.has('--apply')
const includeAll = args.has('--all')
const limitArg = process.argv.find(arg => arg.startsWith('--limit='))
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : undefined
const qqUinArg = stringArg('--qq-uin')
const tokenArg = stringArg('--token')
const deleteVia = stringArg('--delete-via') ?? 'webdav'
const embyRootArg = stringArg('--emby-root')

const audioExtensions = new Set(['flac', 'mp3', 'm4a', 'mp4', 'ogg', 'opus', 'wav'])

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

function stringArg(name: string): string | undefined {
  const prefix = `${name}=`
  return process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length)
}

async function main(): Promise<void> {
  if (args.has('--help') || args.has('-h')) {
    printHelp()
    return
  }

  const fetchedItems = await fetchAudioItems()
  const items = deleteVia === 'webdav' ? await filterExistingWebdavItems(fetchedItems) : fetchedItems
  const groups = duplicateGroups(items)
  const selectedGroups = typeof limit === 'number' && Number.isFinite(limit)
    ? groups.slice(0, Math.max(0, Math.trunc(limit)))
    : groups

  if (!selectedGroups.length) {
    console.log('No duplicate Emby audio files found.')
    return
  }

  console.log(`${apply ? 'Applying' : 'Dry run'} duplicate cleanup for ${selectedGroups.length} group(s).`)
  if (!apply) console.log('Pass --apply to delete the lower-quality duplicate Emby items.')
  if (!includeAll) console.log('Scope: XMusic mapped/managed paths only. Pass --all to inspect every Emby audio item.')
  console.log('')

  for (const group of selectedGroups) {
    console.log(`Keep:   ${describe(group.keep.item)}`)
    for (const duplicate of group.remove) {
      console.log(`Delete: ${describe(duplicate.item)}`)
    }
    console.log('')
  }

  if (!apply) return

  const itemsToDelete = selectedGroups.flatMap(group => group.remove.map(({ item }) => item))
  const ids = itemsToDelete.map(item => item.Id).filter((id): id is string => Boolean(id))
  if (deleteVia === 'emby') {
    await deleteEmbyItems(ids)
  } else if (deleteVia === 'webdav') {
    await deleteEmbyItemFilesViaWebdav(itemsToDelete)
    await notifyEmbyDeletedMedia(itemsToDelete)
    deleteRemoteMappings(ids)
  } else {
    throw new Error(`Unsupported --delete-via value: ${deleteVia}. Use webdav or emby.`)
  }
  console.log(`Deleted ${ids.length} duplicate Emby item(s).`)
}

function printHelp(): void {
  console.log(`Usage:
  npx tsx scripts/cleanup-emby-duplicate-audio.ts [--apply] [--all] [--limit=N]

Defaults to dry-run and only considers items known to be managed by XMusic:
  - remote_mappings entries in XMusic database
  - paths under configured Emby music library locations

When --apply is used, deletion defaults to WebDAV so it does not depend on
the Emby service process having filesystem delete permission. Configure the
account's Emby WebDAV storage in the XMusic UI first.

Options:
  --apply            Delete lower-quality duplicates from Emby
  --all              Consider all Emby audio items, not just XMusic-managed items
  --limit=N          Process only the first N duplicate groups
  --delete-via=MODE  Delete through webdav (default) or emby
  --emby-root=PATH   Emby library root path when it is not cached, e.g. /volume2/music2
  --qq-uin=UIN       Use this account's upstream Emby and WebDAV configuration
  --token=TOKEN      With --delete-via=emby, use this Emby user token`)
}

async function fetchAudioItems(): Promise<EmbyItem[]> {
  const fields = 'Path,MediaSources,MediaStreams,Size,Container,Album,Artists'
  const params = new URLSearchParams({
    IncludeItemTypes: 'Audio',
    Recursive: 'true',
    Fields: fields,
    Limit: '1000',
    StartIndex: '0',
  })
  const items: EmbyItem[] = []

  for (;;) {
    const data = await embyFetch<{ Items?: EmbyItem[]; TotalRecordCount?: number }>(`/Items?${params}`)
    items.push(...(data.Items ?? []).filter(shouldConsiderItem))
    const total = data.TotalRecordCount ?? items.length
    const start = Number(params.get('StartIndex') ?? '0')
    const next = start + Number(params.get('Limit') ?? '1000')
    if (next >= total || !(data.Items?.length)) break
    params.set('StartIndex', String(next))
  }

  return items
}

function shouldConsiderItem(item: EmbyItem): boolean {
  if (!item.Id) return false
  if (!audioExtensions.has(itemContainer(item))) return false
  if (includeAll) return true
  if (xmusicMappedRemoteIds().has(item.Id)) return true
  return configuredLibraryRoots().some(root => normalizePath(itemPath(item)).startsWith(root))
}

function duplicateGroups(items: EmbyItem[]): DuplicateGroup[] {
  const byKey = new Map<string, ScoredItem[]>()
  for (const item of items) {
    const key = duplicateKey(item)
    if (!key) continue
    const list = byKey.get(key) ?? []
    list.push({ item, score: qualityScore(item) })
    byKey.set(key, list)
  }

  return [...byKey.entries()]
    .map(([key, list]) => {
      const sorted = list.sort((left, right) => right.score - left.score || (right.item.Size ?? 0) - (left.item.Size ?? 0))
      return { key, keep: sorted[0], remove: sorted.slice(1) }
    })
    .filter((group): group is DuplicateGroup => Boolean(group.keep && group.remove.length))
}

function duplicateKey(item: EmbyItem): string | undefined {
  const name = normalizeText(item.Name)
  if (!name) return undefined
  const album = normalizeText(item.Album)
  const artists = normalizeText((item.Artists ?? []).join(' '))
  const pathParts = itemPath(item).split('/').filter(Boolean)
  const pathAlbum = normalizeText(pathParts.at(-2))
  const pathArtist = normalizeText(pathParts.at(-3))
  return [artists || pathArtist, album || pathAlbum, name].join('|')
}

function qualityScore(item: EmbyItem): number {
  const container = itemContainer(item)
  const codec = itemCodec(item)
  if (container === 'flac' || codec === 'flac') return 300
  if (container === 'wav' || codec === 'pcm') return 250
  if (container === 'm4a' || container === 'mp4' || codec === 'aac') return 220
  if (container === 'mp3' || codec === 'mp3') return 200
  if (container === 'ogg' || container === 'opus' || codec === 'opus' || codec === 'vorbis') return 150
  return 100
}

function itemPath(item: EmbyItem): string {
  return item.Path ?? item.MediaSources?.[0]?.Path ?? ''
}

function itemContainer(item: EmbyItem): string {
  return (item.Container ?? item.MediaSources?.[0]?.Container ?? extension(itemPath(item))).toLowerCase()
}

function itemCodec(item: EmbyItem): string {
  const streams = item.MediaSources?.flatMap(source => source.MediaStreams ?? []) ?? []
  return (streams.find(stream => stream.Type?.toLowerCase() === 'audio')?.Codec ?? '').toLowerCase()
}

function extension(value: string): string {
  const basename = value.split('/').pop() ?? ''
  const index = basename.lastIndexOf('.')
  return index >= 0 ? basename.slice(index + 1).toLowerCase() : ''
}

function describe(item: EmbyItem): string {
  const size = item.Size ? ` ${formatBytes(item.Size)}` : ''
  return `${item.Id ?? '-'} ${item.Name ?? '-'} [${itemContainer(item)}${size}] ${itemPath(item)}`
}

async function deleteEmbyItems(ids: string[]): Promise<void> {
  if (!ids.length) return
  const token = deleteAuthToken()
  await embyFetch(`/Items/Delete?${new URLSearchParams({ Ids: ids.join(',') })}`, { method: 'POST' }, { token })
}

async function deleteEmbyItemFilesViaWebdav(items: EmbyItem[]): Promise<void> {
  const config = webdavConfig()
  const seen = new Set<string>()
  for (const item of items) {
    const path = itemPath(item)
    const relativePath = relativeWebdavPath(path)
    if (seen.has(relativePath)) continue
    seen.add(relativePath)
    const response = await webdavFetch(config, relativePath, { method: 'DELETE' })
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      throw new Error(`WebDAV DELETE ${relativePath} failed with ${response.status}: ${(await response.text().catch(() => '')).slice(0, 300)}`)
    }
    console.log(`Deleted via WebDAV: ${relativePath}`)
  }
}

async function filterExistingWebdavItems(items: EmbyItem[]): Promise<EmbyItem[]> {
  if (!scriptEmbyConfig().sourceWebdavDsn) return items

  const existing: EmbyItem[] = []
  const stale: EmbyItem[] = []
  for (const item of items) {
    if (await webdavItemExists(item)) {
      existing.push(item)
    } else {
      stale.push(item)
    }
  }

  if (stale.length) {
    console.log(`Skipped ${stale.length} stale Emby item(s) whose files no longer exist on WebDAV.`)
    if (apply) {
      await notifyEmbyDeletedMedia(stale)
      deleteRemoteMappings(stale.map(item => item.Id).filter((id): id is string => Boolean(id)))
    }
  }
  return existing
}

async function webdavItemExists(item: EmbyItem): Promise<boolean> {
  const relativePath = relativeWebdavPath(itemPath(item))
  const response = await webdavFetch(webdavConfig(), relativePath, { method: 'HEAD' })
  if (response.ok) return true
  if (response.status === 404 || response.status === 410) return false
  if (response.status === 405) return webdavItemExistsByPropfind(relativePath)
  throw new Error(`WebDAV HEAD ${relativePath} failed with ${response.status}: ${(await response.text().catch(() => '')).slice(0, 300)}`)
}

async function webdavItemExistsByPropfind(relativePath: string): Promise<boolean> {
  const response = await webdavFetch(webdavConfig(), relativePath, {
    method: 'PROPFIND',
    headers: { depth: '0' },
  })
  if (response.ok || response.status === 207) return true
  if (response.status === 404 || response.status === 410) return false
  throw new Error(`WebDAV PROPFIND ${relativePath} failed with ${response.status}: ${(await response.text().catch(() => '')).slice(0, 300)}`)
}

async function notifyEmbyDeletedMedia(items: EmbyItem[]): Promise<void> {
  const updates = unique(items.map(itemPath).filter(Boolean)).map(path => ({
    Path: path,
    UpdateType: 'Deleted',
  }))
  if (!updates.length) return
  await embyFetch('/Library/Media/Updated', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Updates: updates }),
  }).catch(async () => {
    await embyFetch('/Library/Refresh', { method: 'POST' })
  })
}

async function embyFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
  options: { token?: string } = {},
): Promise<T> {
  const config = scriptEmbyConfig()
  const token = options.token ?? await scriptEmbyToken(config)

  const url = new URL(config.baseUrl)
  const [pathname, search = ''] = path.split('?')
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${(pathname ?? '').replace(/^\/+/, '')}`
  url.search = search ? `?${search}` : ''
  url.searchParams.set('api_key', token)

  const headers = new Headers(init.headers)
  if (token && !headers.has('X-Emby-Token')) headers.set('X-Emby-Token', token)
  if (token && !headers.has('X-Emby-Authorization')) headers.set('X-Emby-Authorization', embyAuthorizationHeader(token))

  const response = await fetch(url, {
    ...init,
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(config.proxyTimeoutMs),
  })
  const text = await response.text().catch(() => '')
  if (!response.ok) throw new Error(`Emby request failed ${response.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) as T : undefined as T
}

let cachedDeleteToken: string | undefined
function deleteAuthToken(): string {
  cachedDeleteToken ??= readDeleteAuthToken()
  return cachedDeleteToken
}

function readDeleteAuthToken(): string {
  if (tokenArg?.trim()) return tokenArg.trim()

  const row = qqUinArg?.trim()
    ? db.prepare(`
      SELECT qq_uin AS qqUin, emby_username AS embyUsername, emby_access_token AS embyAccessToken
      FROM accounts
      WHERE qq_uin = ?
      LIMIT 1
    `).get(qqUinArg.trim()) as AccountTokenRow | undefined
    : db.prepare(`
      SELECT qq_uin AS qqUin, emby_username AS embyUsername, emby_access_token AS embyAccessToken
      FROM accounts
      WHERE emby_access_token IS NOT NULL AND emby_access_token != ''
      ORDER BY updated_at DESC
      LIMIT 1
    `).get() as AccountTokenRow | undefined

  if (row?.embyAccessToken?.trim()) {
    console.log(`Using Emby delete token from XMusic account ${row.qqUin} (${row.embyUsername}).`)
    return row.embyAccessToken.trim()
  }

  if (qqUinArg?.trim()) {
    throw new Error(`No saved upstream Emby access token found for QQ account ${qqUinArg.trim()}. Re-login that account through XMusic or pass --token=TOKEN.`)
  }

  throw new Error('No saved upstream Emby access token found. Re-login any XMusic account, or pass --qq-uin=UIN / --token=TOKEN when using --apply.')
}

function scriptEmbyConfig(): ScriptEmbyConfig {
  cachedScriptEmbyConfig ??= readScriptEmbyConfig()
  return cachedScriptEmbyConfig
}

function readScriptEmbyConfig(): ScriptEmbyConfig {
  const row = qqUinArg?.trim()
    ? db.prepare(`
      SELECT
        qq_uin AS qqUin,
        emby_dsn AS dsn,
        emby_source_webdav_dsn AS sourceWebdavDsn,
        emby_proxy_timeout_ms AS proxyTimeoutMs
      FROM accounts
      WHERE qq_uin = ?
      LIMIT 1
    `).get(qqUinArg.trim()) as AccountEmbyConfigRow | undefined
    : db.prepare(`
      SELECT
        qq_uin AS qqUin,
        emby_dsn AS dsn,
        emby_source_webdav_dsn AS sourceWebdavDsn,
        emby_proxy_timeout_ms AS proxyTimeoutMs
      FROM accounts
      WHERE emby_dsn IS NOT NULL AND emby_dsn != ''
      ORDER BY updated_at DESC
      LIMIT 1
    `).get() as AccountEmbyConfigRow | undefined

  if (!row?.dsn?.trim()) {
    const suffix = qqUinArg?.trim() ? ` for QQ account ${qqUinArg.trim()}` : ''
    throw new Error(`No account upstream Emby configuration found${suffix}. Configure it in the XMusic account Emby settings.`)
  }
  const parsed = parseEmbyDsn(row.dsn)
  console.log(`Using upstream Emby configuration from XMusic account ${row.qqUin}.`)
  return {
    ...parsed,
    sourceWebdavDsn: row.sourceWebdavDsn?.trim() || undefined,
    proxyTimeoutMs: row.proxyTimeoutMs && row.proxyTimeoutMs > 0 ? row.proxyTimeoutMs : 30000,
  }
}

interface ScriptEmbyConfig {
  baseUrl: string
  username: string
  password: string
  sourceWebdavDsn?: string
  proxyTimeoutMs: number
}

let cachedScriptEmbyToken: string | undefined
async function scriptEmbyToken(config: ScriptEmbyConfig): Promise<string> {
  if (cachedScriptEmbyToken) return cachedScriptEmbyToken
  const url = new URL(config.baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/Users/AuthenticateByName`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Emby-Authorization': embyAuthorizationHeader(),
    },
    body: JSON.stringify({ Username: config.username, Pw: config.password }),
    cache: 'no-store',
    signal: AbortSignal.timeout(config.proxyTimeoutMs),
  })
  const text = await response.text().catch(() => '')
  if (!response.ok) throw new Error(`Emby authentication failed ${response.status}: ${text.slice(0, 300)}`)
  const token = (JSON.parse(text || '{}') as { AccessToken?: string }).AccessToken
  if (!token) throw new Error('Emby authentication did not return an access token')
  cachedScriptEmbyToken = token
  return token
}

function parseEmbyDsn(dsn: string): Pick<ScriptEmbyConfig, 'baseUrl' | 'username' | 'password'> {
  const url = new URL(dsn.trim())
  const username = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  if (!username || !password) throw new Error('Emby DSN must include username and password.')
  url.username = ''
  url.password = ''
  return {
    baseUrl: url.toString().replace(/\/+$/g, ''),
    username,
    password,
  }
}

interface AccountEmbyConfigRow {
  qqUin: string
  dsn: string | null
  sourceWebdavDsn: string | null
  proxyTimeoutMs: number | null
}

let cachedScriptEmbyConfig: ScriptEmbyConfig | undefined

interface AccountTokenRow {
  qqUin: string
  embyUsername: string
  embyAccessToken: string | null
}

interface WebdavConfig {
  baseUrl: URL
  authHeader?: string
}

let cachedWebdavConfig: WebdavConfig | undefined
function webdavConfig(): WebdavConfig {
  cachedWebdavConfig ??= readWebdavConfig()
  return cachedWebdavConfig
}

function readWebdavConfig(): WebdavConfig {
  const dsn = scriptEmbyConfig().sourceWebdavDsn
  if (!dsn) throw new Error('Account Emby WebDAV storage must be configured in XMusic to delete duplicate files through WebDAV.')
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

async function webdavFetch(config: WebdavConfig, relativePath: string, init: RequestInit): Promise<Response> {
  const url = webdavUrl(config.baseUrl, relativePath)
  const headers = new Headers(init.headers)
  if (config.authHeader && !headers.has('authorization')) headers.set('authorization', config.authHeader)
  return fetch(url, {
    ...init,
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(scriptEmbyConfig().proxyTimeoutMs),
  })
}

function webdavUrl(baseUrl: URL, relativePath: string): URL {
  const url = new URL(baseUrl.href)
  const basePath = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname
  const encodedRelativePath = relativePath
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
  url.pathname = encodedRelativePath ? `${basePath}/${encodedRelativePath}` : basePath || '/'
  return url
}

function relativeWebdavPath(filePath: string): string {
  const sourcePath = toPosixPath(filePath).replace(/\/+/g, '/')
  const normalizedSourcePath = normalizePath(sourcePath)
  const root = configuredLibraryRoots()
    .sort((left, right) => right.length - left.length)
    .find(candidate => normalizedSourcePath === candidate || normalizedSourcePath.startsWith(`${candidate}/`))
  if (!root) {
    throw new Error(`Cannot map Emby item path to WebDAV path because it is outside configured Emby music library roots: ${filePath}`)
  }
  return sourcePath.slice(root.length).replace(/^\/+/, '')
}

function deleteRemoteMappings(ids: string[]): void {
  if (!ids.length) return
  const statement = db.prepare(`
    DELETE FROM remote_mappings
    WHERE remote = 'emby' AND remote_id = ?
  `)
  const transaction = db.transaction((values: string[]) => {
    for (const id of values) statement.run(id)
  })
  transaction(ids)
}

let mappedRemoteIds: Set<string> | undefined
function xmusicMappedRemoteIds(): Set<string> {
  mappedRemoteIds ??= new Set((db.prepare(`
    SELECT remote_id AS remoteId
    FROM remote_mappings
    WHERE remote = 'emby' AND local_type = 'track'
  `).all() as Array<{ remoteId: string }>).map(row => row.remoteId))
  return mappedRemoteIds
}

let libraryRoots: string[] | undefined
function configuredLibraryRoots(): string[] {
  libraryRoots ??= readConfiguredLibraryRoots()
  return libraryRoots
}

function readConfiguredLibraryRoots(): string[] {
  const rows = db.prepare(`
    SELECT value_json AS valueJson
    FROM app_settings
    WHERE key IN ('emby.upstreamMusicLibraryMapping', 'emby.upstreamMusicLibraryIds')
  `).all() as Array<{ valueJson: string }>

  const roots: string[] = []
  for (const row of rows) {
    const parsed = JSON.parse(row.valueJson) as unknown
    if (isObject(parsed) && Array.isArray(parsed.locations)) {
      roots.push(...parsed.locations.filter((value): value is string => typeof value === 'string'))
    } else if (Array.isArray(parsed)) {
      roots.push(...parsed.filter((value): value is string => typeof value === 'string' && value.startsWith('/')))
    }
  }
  if (embyRootArg?.trim()) roots.push(embyRootArg.trim())
  return roots.map(normalizePath).filter(Boolean)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/')
}

function normalizePath(value: string): string {
  return value.trim().toLowerCase().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '')
}

function normalizeText(value?: string): string {
  return (value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function formatBytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size.toFixed(index === 0 ? 0 : 1)}${units[index]}`
}
