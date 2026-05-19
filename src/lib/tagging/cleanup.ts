import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { appConfig } from '@/lib/config'
import { db } from '@/lib/db'

export async function cleanupInboxFile(input: {
  trackFileId: number
  rawPath?: string
  finalPath?: string
}): Promise<boolean> {
  if (!input.rawPath || !isPathInside(input.rawPath, appConfig.inboxDir)) return false
  if (input.finalPath && path.resolve(input.rawPath) === path.resolve(input.finalPath)) return false

  try {
    await unlink(input.rawPath)
  } catch (error) {
    if (!isMissingFileError(error)) throw error
  }

  db.prepare(`
    UPDATE track_files
    SET raw_path = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND raw_path = ?
  `).run(input.trackFileId, input.rawPath)

  return true
}

function isPathInside(candidate: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate))
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
