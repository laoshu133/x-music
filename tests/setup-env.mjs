process.env.NODE_ENV ??= 'test'
process.env.DATABASE_URL ??= `file:/tmp/x-music-test-${process.pid}.sqlite`
process.env.EMBY_UPSTREAM_URL ??= 'http://127.0.0.1:8096'
process.env.EMBY_API_KEY ??= 'test-emby-api-key'
