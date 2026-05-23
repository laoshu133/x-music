import path from 'node:path'

const encryptedQQAudioExtensions = new Set(['.mgg', '.mflac'])
export const encryptedQQAudioRequiresKeyMessage = 'QQ encrypted audio requires a matching QQ Music local key; no decryptable or non-encrypted URL was available.'

export class EncryptedQQAudioRequiresKeyError extends Error {
  constructor(detail: string) {
    super(`QQ encrypted audio requires a matching QQ Music ekey; ${detail}`)
    this.name = 'EncryptedQQAudioRequiresKeyError'
  }
}

export function isEncryptedQQAudioFileName(filePath: string): boolean {
  return encryptedQQAudioExtensions.has(path.extname(safeUrlPathname(filePath)).toLowerCase())
}

export function isEncryptedQQAudioRequiresKeyError(error: unknown): boolean {
  return error instanceof EncryptedQQAudioRequiresKeyError
    || (error instanceof Error && error.message.includes('QQ encrypted audio requires a matching QQ Music local key'))
    || (error instanceof Error && error.message.includes('QQ encrypted audio requires a matching QQ Music ekey'))
}

function safeUrlPathname(value: string): string {
  try {
    return new URL(value).pathname
  } catch {
    return value
  }
}
