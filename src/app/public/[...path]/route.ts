import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const runtime = 'nodejs'
export const dynamic = 'force-static'

const contentTypes: Record<string, string> = {
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: parts } = await params
  const publicRoot = path.join(process.cwd(), 'src/public')
  const filePath = path.resolve(publicRoot, ...parts)

  if (!filePath.startsWith(publicRoot + path.sep)) {
    return Response.json({ error: 'Invalid public asset path' }, { status: 400 })
  }

  try {
    const body = await readFile(filePath)
    return new Response(body, {
      headers: {
        'content-type': contentTypes[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'public, max-age=86400',
      },
    })
  } catch {
    return Response.json({ error: 'Public asset not found' }, { status: 404 })
  }
}
