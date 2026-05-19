import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const runtime = 'nodejs'
export const dynamic = 'force-static'

export async function GET() {
  const body = await readFile(path.join(process.cwd(), 'src/public/favicon.ico'))
  return new Response(body, {
    headers: {
      'content-type': 'image/x-icon',
      'cache-control': 'public, max-age=86400',
    },
  })
}
