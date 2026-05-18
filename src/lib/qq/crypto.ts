import crypto from 'node:crypto'

const PART_1_INDEXES = [23, 14, 6, 36, 16, 40, 7, 19] as const
const PART_2_INDEXES = [16, 1, 32, 12, 19, 27, 8, 5] as const
const SCRAMBLE_VALUES = [
  89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133,
  143, 161, 121, 179,
] as const

function pickHashByIndex(hash: string, indexes: readonly number[]) {
  return indexes.map((index) => hash[index]).join('')
}

function base64Encode(data: number[]) {
  return Buffer.from(data)
    .toString('base64')
    .replace(/[\\/+=]/g, '')
}

export function zzcSign(text: string) {
  const hash = crypto.createHash('sha1').update(text).digest('hex')
  const part1 = pickHashByIndex(hash, PART_1_INDEXES)
  const part2 = pickHashByIndex(hash, PART_2_INDEXES)
  const part3 = SCRAMBLE_VALUES.map((value, index) => {
    return value ^ Number.parseInt(hash.slice(index * 2, index * 2 + 2), 16)
  })
  return `zzc${part1}${base64Encode(part3)}${part2}`.toLowerCase()
}
