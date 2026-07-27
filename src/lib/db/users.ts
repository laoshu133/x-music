import crypto from 'node:crypto'
import { db } from '@/lib/db'
import { normalizeDbDateTime, normalizeOptionalDbDateTime } from '@/lib/db/time'
import { encryptSecret, hashPassword, randomToken, verifyPassword } from '@/lib/security'

export type UserRole = 'admin' | 'user'
export type UserStatus = 'active' | 'disabled'

export interface UserRecord {
  id: string
  username: string
  passwordHash: string
  role: UserRole
  status: UserStatus
  displayName?: string
  lastLoginAt?: string
  lastLoginIp?: string
  lastActiveAt?: string
  createdAt: string
  updatedAt: string
}

interface UserRow {
  id: string
  username: string
  password_hash: string
  role: UserRole
  status: UserStatus
  display_name: string | null
  last_login_at: string | null
  last_login_ip: string | null
  last_active_at: string | null
  created_at: string
  updated_at: string
}

export class UsernameValidationError extends Error {}
export class UsernameTakenError extends Error {}

export async function createUser(input: { username: string; password: string; loginIp?: string }): Promise<{ user: UserRecord; playerPassword: string }> {
  const username = normalizeUsername(input.username)
  validatePassword(input.password)
  const passwordHash = await hashPassword(input.password)
  const playerPassword = randomToken(18)
  const userId = crypto.randomUUID()

  try {
    db.transaction(() => {
      const firstUser = (db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count === 0
      db.prepare(`
        INSERT INTO users (id, username, password_hash, role, status, last_login_at, last_login_ip, last_active_at)
        VALUES (@id, @username, @passwordHash, @role, 'active', CURRENT_TIMESTAMP, @loginIp, CURRENT_TIMESTAMP)
      `).run({
        id: userId,
        username,
        passwordHash,
        role: firstUser ? 'admin' : 'user',
        loginIp: input.loginIp ?? null,
      })
      db.prepare(`
        INSERT INTO user_emby_profiles (user_id, player_password_encrypted)
        VALUES (?, ?)
      `).run(userId, encryptSecret(playerPassword))
    }).immediate()
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed: users.username')) throw new UsernameTakenError('该用户名已被使用')
    throw error
  }

  return { user: getUserById(userId)!, playerPassword }
}

export async function authenticateUser(usernameInput: string, password: string): Promise<UserRecord | undefined> {
  let username: string
  try {
    username = normalizeUsername(usernameInput)
  } catch {
    return undefined
  }
  const user = getUserByUsername(username)
  if (!user || user.status !== 'active') return undefined
  return await verifyPassword(password, user.passwordHash) ? user : undefined
}

export function getUserById(userId: string): UserRecord | undefined {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined
  return row ? rowToUser(row) : undefined
}

export function getUserByUsername(username: string): UserRecord | undefined {
  const row = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username) as UserRow | undefined
  return row ? rowToUser(row) : undefined
}

export function listUsers(): UserRecord[] {
  return (db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as UserRow[]).map(rowToUser)
}

export function markUserActive(userId: string): void {
  db.prepare('UPDATE users SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId)
}

export function markUserLogin(userId: string, loginIp?: string): void {
  db.prepare(`
    UPDATE users
    SET last_login_at = CURRENT_TIMESTAMP,
        last_login_ip = COALESCE(?, last_login_ip),
        last_active_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(loginIp ?? null, userId)
}

export function isAdminUser(user: Pick<UserRecord, 'role' | 'status'> | undefined): boolean {
  return user?.role === 'admin' && user.status === 'active'
}

export function normalizeUsername(value: string): string {
  const username = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    throw new UsernameValidationError('用户名格式不正确')
  }
  return username
}

function validatePassword(password: string): void {
  if (password.length < 8 || password.length > 128) throw new Error('密码长度需为 8 到 128 位')
}

function rowToUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    status: row.status,
    displayName: row.display_name ?? undefined,
    lastLoginAt: normalizeOptionalDbDateTime(row.last_login_at),
    lastLoginIp: row.last_login_ip ?? undefined,
    lastActiveAt: normalizeOptionalDbDateTime(row.last_active_at),
    createdAt: normalizeDbDateTime(row.created_at),
    updatedAt: normalizeDbDateTime(row.updated_at),
  }
}
