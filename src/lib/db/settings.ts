import { appConfig } from '@/lib/config'
import { db } from './index'

export type AppSettingKey =
  | 'qq.enabled'
  | 'qq.syncFavorites'
  | 'qq.syncPlayHistory'

export interface EffectiveAppSettings {
  lx: {
    sourceScriptUrl?: string
  }
  emby: {
    baseUrl: string
    apiKey: string
    proxyTimeoutMs: number
  }
  qq: {
    enabled: boolean
    syncFavorites: boolean
    syncPlayHistory: boolean
  }
  gateway: {
    accountMode: 'per-account'
  }
  player: {
    ampcastUrl: string
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

export function getEffectiveSettings(): EffectiveAppSettings {
  return {
    lx: {
      sourceScriptUrl: appConfig.lxMusicSourceScript,
    },
    emby: {
      baseUrl: appConfig.embyUpstreamUrl,
      apiKey: appConfig.embyApiKey,
      proxyTimeoutMs: appConfig.embyProxyTimeoutMs,
    },
    qq: {
      enabled: booleanSetting('qq.enabled', true),
      syncFavorites: booleanSetting('qq.syncFavorites', true),
      syncPlayHistory: booleanSetting('qq.syncPlayHistory', true),
    },
    gateway: {
      accountMode: 'per-account',
    },
    player: {
      ampcastUrl: appConfig.ampcastUrl,
    },
  }
}

export function updateEffectiveSettings(input: Partial<{
  qqEnabled: boolean
  qqSyncFavorites: boolean
  qqSyncPlayHistory: boolean
}>): EffectiveAppSettings {
  if ('qqEnabled' in input && typeof input.qqEnabled === 'boolean') setSetting('qq.enabled', input.qqEnabled)
  if ('qqSyncFavorites' in input && typeof input.qqSyncFavorites === 'boolean') setSetting('qq.syncFavorites', input.qqSyncFavorites)
  if ('qqSyncPlayHistory' in input && typeof input.qqSyncPlayHistory === 'boolean') setSetting('qq.syncPlayHistory', input.qqSyncPlayHistory)
  return getEffectiveSettings()
}
