# miXmusic

Private QQ Music web player with LX-compatible music URL resolution, local caching, and built-in metadata tagging.

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

Compose starts two services:

- `web`: Next.js UI and API on port `3000`.
- `worker`: SQLite job poller for cache/tagging jobs.

All services share `./data`:

```text
data/
  app.sqlite        # SQLite database
  staging/          # incomplete transfer files
  inbox/            # completed raw downloads awaiting tagging
  music/            # final tagged music library
```

## Architecture

- Next.js serves the UI and API routes.
- A Node worker handles background jobs using SQLite-backed job rows.
- The worker tags and organizes cached files with the built-in provider.
- First release targets QQ Music only.

## Cache Flow

1. Resolve a playable URL through `LX_MUSIC_SOURCE_SCRIPT`.
2. Stream the single upstream response to the browser first.
3. Tee the same stream to `data/staging/*.part`.
4. Move completed files to `data/inbox`.
5. Create a SQLite `tag_track_file` job.
6. The worker claims queued jobs and calls the configured tagging provider.
7. The default built-in provider reads existing tags with `music-metadata`, enriches QQ Music metadata when available, writes MP3/FLAC tags, and copies the final file into `data/music`.
8. Store `source + songmid + quality -> rawPath/finalPath/lyricsPath/coverPath/taggedAt` mappings in SQLite.
9. Later playback first checks SQLite for an existing local `ready`, `tagging`, `cached_raw`, or cached-but-failed file before resolving another upstream URL.

## Local Favorites and Status

- `GET /api/favorites` returns local favorite songs from SQLite.
- `POST /api/favorites` accepts a normalized song plus `favorite: true | false`, updates local state, and marks the row `pending` for later QQ sync.
- `GET /api/favorites/status?source=tx&songmid=...` returns local favorite and pending state for one song.
- `GET /api/health` reports database counts, cache directory access, job counts, local favorite pending counts, and missing required configuration.

## Playback History

- `GET /api/history?limit=50` returns recent local play events joined with normalized song metadata.
- The web client includes a "历史" tab that can refresh recent plays and replay any listed track.
- After `/api/play` successfully starts a local or upstream stream, miXmusic records the local play event and best-effort calls a conservative QQ Music private play-history write wrapper. That QQ call is intentionally non-blocking; missing login state, endpoint rejection, or network failure must not stop local playback.

## QQ Account and User APIs

- `GET /api/account` reports the active QQ login state from stored Cookie or `QQ_MUSIC_COOKIE`.
- `POST /api/account/import` validates and optionally persists a copied QQ Music Cookie.
- `DELETE /api/account` clears the locally stored login state.
- `GET /api/account/qr` returns a QQ login QR image plus `ptqrtoken` and `qrsig`.
- `POST /api/account/qr/check` polls QQ QR login status and persists the returned session Cookie on success.
- `GET /api/user/avatar?uin=...&size=140` returns a QQ avatar URL.
- `GET /api/user/playlists?limit=30` returns the logged-in user's QQ playlists; `uin=...` can target a specific QQ number.

The QR and user APIs follow the request flow from `sansenjian/qq-music-api`. The play-history sync wrapper is conservative because the current upstream source does not expose a documented stable write endpoint. These private QQ Music flows still need live-account verification because QQ's private login, profile, and history endpoints can change without notice.

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

- `LX_MUSIC_SOURCE_SCRIPT`: required LX Music custom source script URL for playback.
- `WORKER_POLL_INTERVAL_MS`: idle polling interval, default `5000`.
- `WORKER_MAX_ATTEMPTS`: max attempts before a job is marked failed, default `3`.
- `TAGGING_WRITE_TAGS`: write supported file tags, default `true`.
- `TAGGING_FETCH_ONLINE_METADATA`: fetch QQ Music detail, lyrics, and cover metadata when possible, default `true`.
- `TAGGING_ORGANIZE_FILES`: organize final files as `artist/album/artist - title.ext`, default `true`.
- `TAGGING_FETCH_TIMEOUT_MS`: network metadata/API timeout, default `5000`.

## Tagging Provider

The built-in provider ports the practical parts of music-tag-web's scraping flow into miXmusic. Reference project: https://github.com/xhongc/music-tag-web

- match candidates by title, artist, and album score;
- prefer QQ Music song detail by `songmid`, then search by title and artist;
- fetch QQ Music lyrics and cover images during scraping when enabled;
- write title, artist, album, year, lyrics, cover, and QQ album id for MP3/FLAC when supported;
- organize final files under `data/music` using deterministic paths so repeated jobs replace the same library file instead of creating `(... )` duplicates;
- write Emby-friendly sidecars next to the track: `cover.jpg/png` for the album cover and `artist - title.lrc` for synchronized lyrics when available.

Unsupported tag-write formats degrade to organized file copy with a worker warning instead of failing the cache job.
