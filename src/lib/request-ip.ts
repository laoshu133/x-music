export function readRequestIp(request: Request): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for')
  const firstForwarded = forwarded?.split(',', 1)[0]?.trim()
  if (firstForwarded) return firstForwarded

  return request.headers.get('x-real-ip')
    ?? request.headers.get('cf-connecting-ip')
    ?? undefined
}
