import { getEffectiveSettings, updateEffectiveSettings } from '@/lib/db/settings'
import { withRequestLog } from '@/lib/request-log'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  lxSourceScriptUrl: z.string().optional(),
  embyBaseUrl: z.string().optional(),
  embyApiKey: z.string().optional(),
  embyProxyTimeoutMs: z.coerce.number().int().positive().optional(),
  qqEnabled: z.boolean().optional(),
  qqSyncFavorites: z.boolean().optional(),
  qqSyncPlayHistory: z.boolean().optional(),
})

export async function GET(request: Request): Promise<Response> {
  return withRequestLog(request, async () => Response.json(redactSettings()))
}

export async function PUT(request: Request): Promise<Response> {
  return withRequestLog(request, async () => {
    const body = await request.json().catch(() => undefined)
    const parsed = updateSchema.safeParse(body)
    if (!parsed.success) {
      return Response.json({ error: 'Invalid config payload', issues: parsed.error.issues }, { status: 400 })
    }
    const settings = updateEffectiveSettings(parsed.data)
    return Response.json(redactSettings(settings))
  })
}

function redactSettings(settings = getEffectiveSettings()) {
  return {
    ...settings,
    emby: {
      ...settings.emby,
      hasApiKey: Boolean(settings.emby.apiKey),
      apiKey: settings.emby.apiKey ? '********' : undefined,
    },
  }
}
