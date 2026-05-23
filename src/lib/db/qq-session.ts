import { db } from '@/lib/db'
import { upsertAccountFromQQCookie } from '@/lib/db/accounts'
import { buildQQLoginState, summarizeQQLoginState, type QQLoginState } from '@/lib/qq/account'

interface QQSessionRow {
  cookie: string
  uin: string
  encrypted_uin: string | null
  qqmusic_key: string | null
  updated_at: string
}

export function getStoredQQLoginState(): QQLoginState | undefined {
  const row = db.prepare('SELECT * FROM qq_session WHERE id = 1').get() as QQSessionRow | undefined
  if (!row) return undefined

  return {
    cookie: row.cookie,
    uin: row.uin,
    encryptedUin: row.encrypted_uin ?? undefined,
    qqmusicKey: row.qqmusic_key ?? undefined,
    source: 'stored',
  }
}

export function saveQQLoginCookie(cookieText: string, options: { loginIp?: string } = {}) {
  const state = buildQQLoginState(cookieText, 'stored')
  const result = upsertAccountFromQQCookie(cookieText, options)
  db.prepare(`
    INSERT INTO qq_session (id, cookie, uin, encrypted_uin, qqmusic_key, updated_at)
    VALUES (1, @cookie, @uin, @encryptedUin, @qqmusicKey, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      cookie = excluded.cookie,
      uin = excluded.uin,
      encrypted_uin = excluded.encrypted_uin,
      qqmusic_key = excluded.qqmusic_key,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    cookie: state.cookie,
    uin: state.uin,
    encryptedUin: state.encryptedUin ?? null,
    qqmusicKey: state.qqmusicKey ?? null,
  })

  return {
    ...summarizeQQLoginState(state),
    nickname: result.account.qqNickname,
    emby: {
      username: result.account.embyUsername,
      hasPassword: Boolean(result.account.embyPassword),
      userId: result.account.embyUserId,
      hasAccessToken: Boolean(result.account.embyAccessToken),
      generatedPassword: result.generatedPassword,
    },
  }
}

export function clearQQLoginCookie(): void {
  db.prepare('DELETE FROM qq_session WHERE id = 1').run()
}
