import { cookies } from 'next/headers'
import { getAccountByQQ, markAccountActive, type AccountRecord } from '@/lib/db/accounts'

const sessionCookieName = 'x_music_account'

export async function getCurrentAccount(): Promise<AccountRecord | undefined> {
  const store = await cookies()
  const qqUin = store.get(sessionCookieName)?.value
  if (!qqUin) return undefined
  markAccountActive(qqUin)
  return getAccountByQQ(qqUin)
}

export async function setCurrentAccount(qqUin: string): Promise<void> {
  const store = await cookies()
  store.set(sessionCookieName, qqUin, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  })
}

export async function clearCurrentAccount(): Promise<void> {
  const store = await cookies()
  store.delete(sessionCookieName)
}
