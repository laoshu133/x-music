import { appConfig } from '@/lib/config'
import { db } from './index'

export type AppSettingKey =
  | 'lx.sourceScriptUrl'
  | 'emby.baseUrl'
  | 'emby.apiKey'
  | 'emby.username'
  | 'emby.password'
  | 'emby.accessToken'
  | 'emby.userId'
  | 'emby.serverId'
  | 'emby.proxyTimeoutMs'
  | 'qq.enabled'
  | 'qq.syncFavorites'
  | 'qq.syncPlayHistory'

export interface EffectiveAppSettings {
  lx: {
    sourceScriptUrl?: string
  }
  emby: {
    baseUrl?: string
    apiKey?: string
    username?: string
    password?: string
    accessToken?: string
    userId?: string
    serverId?: string
    proxyTimeoutMs: number
  }
  qq: {
    enabled: boolean
    syncFavorites: boolean
    syncPlayHistory: boolean
  }
}

const now = () => new Date().toISOString()

export function getSetting<T>(key: AppSettingKey): T | undefined {
  const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key) as { value_json: string } | undefined
  if (!row) return undefined
  return JSON.parse(row.value_json) as T
}

export function setSetting<T>(key: AppSettingKey, value: T): void {
  db.prepare(`
    INSERT INTO app_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), now())
}

export function deleteSetting(key: AppSettingKey): void {
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(key)
}

function stringSetting(key: AppSettingKey, fallback?: string): string | undefined {
  const value = getSetting<unknown>(key)
  if (typeof value === 'string' && value.trim()) return value.trim()
  return fallback
}

function booleanSetting(key: AppSettingKey, fallback: boolean): boolean {
  const value = getSetting<unknown>(key)
  return typeof value === 'boolean' ? value : fallback
}

function numberSetting(key: AppSettingKey, fallback: number): number {
  const value = getSetting<unknown>(key)
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

export function getEffectiveSettings(): EffectiveAppSettings {
  return {
    lx: {
      sourceScriptUrl: stringSetting('lx.sourceScriptUrl', appConfig.lxMusicSourceScript),
    },
    emby: {
      baseUrl: stringSetting('emby.baseUrl', appConfig.embyUpstreamUrl),
      apiKey: stringSetting('emby.apiKey', appConfig.embyApiKey),
      username: stringSetting('emby.username'),
      password: stringSetting('emby.password'),
      accessToken: stringSetting('emby.accessToken'),
      userId: stringSetting('emby.userId'),
      serverId: stringSetting('emby.serverId'),
      proxyTimeoutMs: numberSetting('emby.proxyTimeoutMs', appConfig.embyProxyTimeoutMs),
    },
    qq: {
      enabled: booleanSetting('qq.enabled', true),
      syncFavorites: booleanSetting('qq.syncFavorites', true),
      syncPlayHistory: booleanSetting('qq.syncPlayHistory', true),
    },
  }
}

export function updateEffectiveSettings(input: Partial<{
  lxSourceScriptUrl: string
  embyBaseUrl: string
  embyDsn: string
  embyApiKey: string
  embyProxyTimeoutMs: number
  qqEnabled: boolean
  qqSyncFavorites: boolean
  qqSyncPlayHistory: boolean
}>): EffectiveAppSettings {
  if ('lxSourceScriptUrl' in input) setNullableString('lx.sourceScriptUrl', input.lxSourceScriptUrl)
  if ('embyBaseUrl' in input) setNullableString('emby.baseUrl', input.embyBaseUrl)
  if ('embyDsn' in input) applyEmbyDsn(input.embyDsn)
  if ('embyApiKey' in input) setNullableString('emby.apiKey', input.embyApiKey)
  if ('embyProxyTimeoutMs' in input && input.embyProxyTimeoutMs !== undefined) {
    setSetting('emby.proxyTimeoutMs', Math.max(1000, Math.floor(input.embyProxyTimeoutMs)))
  }
  if ('qqEnabled' in input && typeof input.qqEnabled === 'boolean') setSetting('qq.enabled', input.qqEnabled)
  if ('qqSyncFavorites' in input && typeof input.qqSyncFavorites === 'boolean') setSetting('qq.syncFavorites', input.qqSyncFavorites)
  if ('qqSyncPlayHistory' in input && typeof input.qqSyncPlayHistory === 'boolean') setSetting('qq.syncPlayHistory', input.qqSyncPlayHistory)
  return getEffectiveSettings()
}

function applyEmbyDsn(value: string | undefined): void {
  const normalized = value?.trim()
  if (!normalized) return
  const parsed = new URL(normalized)
  const baseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '')}`
  setSetting('emby.baseUrl', baseUrl)
  if (parsed.username) setSetting('emby.username', decodeURIComponent(parsed.username))
  if (parsed.password) setSetting('emby.password', decodeURIComponent(parsed.password))
}

function setNullableString(key: AppSettingKey, value: string | undefined): void {
  const normalized = value?.trim()
  if (normalized) {
    setSetting(key, normalized)
  } else {
    deleteSetting(key)
  }
}
