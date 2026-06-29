const bindHost = process.env.HOST || process.env.X_MUSIC_BIND_HOST || '0.0.0.0'

process.env.HOSTNAME = bindHost

await import('../server.js')
