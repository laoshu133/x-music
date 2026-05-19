export async function handleLocalEmbyRequest(_request: Request, embyPath: string): Promise<Response | undefined> {
  if (_request.method === 'GET' && embyPath === '/System/Info/Public') {
    return Response.json({
      LocalAddress: '',
      ServerName: 'miXmusic',
      Version: '0.1.0',
      ProductName: 'miXmusic Emby Gateway',
      Id: 'mixmusic',
      StartupWizardCompleted: true,
    })
  }

  if (_request.method === 'GET' && embyPath === '/mixmusic/health') {
    return Response.json({ ok: true, service: 'mixmusic-emby-gateway' })
  }

  return undefined
}
