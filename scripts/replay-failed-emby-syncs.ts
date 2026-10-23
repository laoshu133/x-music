import { getAccountByQQ } from '@/lib/db/accounts'
import { replayFailedEmbyTrackSyncs } from '@/lib/emby/sync'

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  return process.argv[index + 1]
}

const apply = process.argv.includes('--apply')
const qqUin = optionValue('--qq-uin')
const userId = qqUin ? getAccountByQQ(qqUin)?.userId : undefined
if (qqUin && !userId) {
  console.error(JSON.stringify({ error: `No XMusic account found for QQ ${qqUin}` }))
  process.exitCode = 1
} else {
  const parsedLimit = Number(optionValue('--limit') ?? 25)
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.trunc(parsedLimit)) : 25
  const result = replayFailedEmbyTrackSyncs({ userId, dryRun: !apply, limit })
  console.log(JSON.stringify({ dryRun: !apply, limit, ...result }))
}
