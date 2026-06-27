process.env.NODE_ENV ??= 'test'
process.env.DATABASE_URL ??= `file:/tmp/x-music-test-${process.pid}.sqlite`
process.env.MUSIC_DATA_DIR ??= `/tmp/x-music-test-data-${process.pid}`
