const sqliteUtcDateTimePattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/

export function normalizeDbDateTime(value: string): string {
  if (!sqliteUtcDateTimePattern.test(value)) return value
  const date = new Date(`${value.replace(' ', 'T')}Z`)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

export function normalizeOptionalDbDateTime(value: string | null | undefined): string | undefined {
  return value ? normalizeDbDateTime(value) : undefined
}

export function normalizeNullableDbDateTime(value: string | null | undefined): string | null {
  return value ? normalizeDbDateTime(value) : null
}
