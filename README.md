# miXmusic

Private QQ Music web player with LX-compatible music URL resolution, local caching, and music-tag-web scraping.

## Development

```bash
cp .env.example .env
npm run dev
```

Run the worker in a second terminal when testing background jobs:

```bash
npm run worker
```

## Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

Compose starts three services:

- `web`: Next.js UI and API on port `3000`.
- `worker`: SQLite job poller for tagging jobs.
- `music-tag-web`: scraper/tagger sidecar on port `8001`.

All services share `./data`:

```text
data/
  app.sqlite        # SQLite database
  staging/          # incomplete transfer files
  inbox/            # completed raw downloads awaiting tagging
  music/            # final tagged music library
  music-tag-web/    # music-tag-web application data
```

## Architecture

- Next.js serves the UI and API routes.
- A Node worker handles background jobs using SQLite-backed job rows.
- `music-tag-web` runs as a sidecar and shares the `data/inbox` and `data/music` directories.
- First release targets QQ Music only.

## Cache Flow

1. Resolve a playable URL through `LX_MUSIC_URL_SCRIPT`.
2. Stream the single upstream response to the browser first.
3. Tee the same stream to `data/staging/*.part`.
4. Move completed files to `data/inbox`.
5. Create a SQLite `tag_track_file` job.
6. The worker claims queued jobs and calls the configured tagging provider.
7. If `MUSIC_TAG_WEB_API_URL` is configured, the provider probes `music-tag-web` HTTP endpoints and tries to submit a tagging task.
8. If no supported API is found, shared-directory fallback waits for `music-tag-web` to scan `data/inbox` and write the final file into `data/music`.
9. Store `source + songmid + quality -> finalPath` mappings in SQLite.

## Worker Jobs

The `jobs` table is created lazily and supports `queued`, `running`, `completed`, and `failed` states. The worker currently handles `tag_track_file` payloads:

```json
{
  "trackFileId": 1,
  "rawPath": "/app/data/inbox/example.flac",
  "source": "tx",
  "songmid": "003abc",
  "quality": "flac",
  "title": "Song title",
  "artist": "Artist name",
  "album": "Album name"
}
```

Relevant environment variables:

- `WORKER_POLL_INTERVAL_MS`: idle polling interval, default `5000`.
- `WORKER_MAX_ATTEMPTS`: max attempts before a job is marked failed, default `3`.
- `MUSIC_TAG_WEB_API_URL`: optional music-tag-web base URL. In Compose this is `http://music-tag-web:8001`.
- `TAGGING_POLL_TIMEOUT_MS`: shared-directory fallback timeout, default `120000`.
- `TAGGING_POLL_INTERVAL_MS`: fallback scan interval, default `5000`.

## music-tag-web Integration

The HTTP integration is intentionally a probe-first skeleton because `music-tag-web` does not provide a stable API contract in this project yet. Until the real endpoint is confirmed, the worker falls back to shared directories:

- raw completed files land in `data/inbox`;
- `music-tag-web` scans and organizes them;
- the worker polls `data/music` and matches candidates by title, artist, songmid, size, and modification time.

Before relying on this in production, verify the actual `music-tag-web` container paths, scan settings, and any available API endpoints.
