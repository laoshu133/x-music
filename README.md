# XMusic

XMusic (code: `x-music`) is a private QQ Music to Emby gateway. It lets Emby-compatible players, especially ampcast, browse and play a merged music library backed by an upstream Emby server plus QQ Music virtual content.

The app is for personal/private deployment. It is not designed as a public multi-user music service.

## Current Capabilities

- QQ account login by QR code or pasted y.qq.com Cookie.
- Per-QQ Emby gateway account creation. Usernames are normalized as `QQ${QQ_UID}`.
- Upstream Emby user binding with restricted policy:
  - only the music library is enabled;
  - channel access is disabled;
  - remote control and shared device control are disabled.
- Emby-compatible gateway endpoints for ampcast:
  - local authentication;
  - user views and virtual music library;
  - merged songs, albums, playlists, genres, favorites, most played, and recently played lists;
  - QQ virtual playlist and album expansion;
  - image proxying for real Emby items and QQ virtual artwork;
  - virtual QQ audio playback;
  - playback report handling without leaking virtual IDs to upstream Emby.
- QQ Music list pagination is capped to safe upstream page sizes and walks `StartIndex + Limit` windows.
- Local playback cache:
  - first playback streams upstream audio while teeing to local storage;
  - later playback reuses ready or playable cached files;
  - cached local files support HTTP Range.
- SQLite-backed persistence for accounts, tracks, files, jobs, play events, favorites, virtual items, and remote mappings.
- Worker job pipeline for tagging, file organization, and Emby sync jobs.
- Built-in metadata/tagging path using QQ metadata, lyrics, covers, MP3/FLAC tags, and Emby-friendly sidecars.
- Health/config APIs and a management UI for login, connection info, runtime settings, and status checks.

## Development

```bash
cp .env.example .env
npm install
npm run dev
```

The default local development server is:

```text
http://localhost:3004
```

Run the worker in a second terminal when testing background jobs:

```bash
npm run worker
```

Useful checks:

```bash
npm run typecheck
npm test
```

## Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

Compose starts three services:

- `web`: Next.js UI, APIs, and Emby gateway on port `8098`.
- `worker`: SQLite job poller for cache, tagging, and Emby sync jobs.
- `ampcast`: bundled ampcast web player on port `8000`, used by XMusic's same-origin `/@player` proxy.

XMusic uses the internal player URL `http://ampcast:8000/` by default, so the
embedded player no longer depends on the public `https://ampcast.app/` service.
You can still open the player directly from the host at:

```text
http://localhost:8000
```

To deploy XMusic together with a bundled Emby server, use the overlay Compose
file:

```bash
docker compose -f docker-compose.yml -f docker-compose.emby.yml up --build
```

Then set XMusic's upstream Emby URL in `.env` to the internal Compose service:

```env
EMBY_UPSTREAM_URL=http://emby:8096
```

For an external Emby server, `EMBY_UPSTREAM_URL` must be reachable from the
XMusic container. Use `host.docker.internal` for a host-machine Emby service
where supported, or a LAN/reverse-proxy address for another machine.

The bundled Emby service stores configuration in the `emby-config` volume and
mounts XMusic's shared data volume read-only at `/app/data`. In Emby, add
`/app/data/music` as the music library path so XMusic sync jobs can match the
final organized file paths. If you already run Emby elsewhere, keep using the
default `docker-compose.yml` and point `EMBY_UPSTREAM_URL` at that external
server instead.

All services share `./data`:

```text
data/
  app.sqlite        # SQLite database
  staging/          # incomplete transfer files
  inbox/            # completed raw downloads awaiting tagging
  music/            # final tagged music library
```

## Emby Gateway

For local development, point ampcast or another Emby-compatible client at:

```text
http://localhost:3004
```

For Docker or production deployment, point clients at:

```text
http://localhost:8098
```

The service root is the Emby-compatible gateway. Emby-style paths such as
`/System/Info/Public`, `/Users/AuthenticateByName`, and `/Users/{id}/Items`
are handled directly from the root.

After QQ login, use the account information shown in the UI:

- Username: `QQ${QQ_UID}`
- Password: generated on first login, editable in the account Emby config

The exposed virtual music library uses `x-music-music`.

## Environment

Required:

- `LX_MUSIC_SOURCE_SCRIPT`: LX Music custom source script URL for playback URL resolution.
- `EMBY_UPSTREAM_URL`: upstream Emby server used for fallback proxying, account binding, library lookup, and sync.
- `EMBY_API_KEY`: upstream Emby API key for server-side admin/fallback requests.

Optional:

- `DATABASE_URL`: SQLite database URL, default `file:./data/app.sqlite`.
- `MUSIC_DATA_DIR`: shared music data root, default `./data`.
- `PORT`: production/server port, default deployment value `8098`; local `npm run dev` uses `3004`.
- `AMPCAST_PORT`: optional host port for the bundled ampcast container in Docker Compose, default `8000`.
- `EMBY_PROXY_TIMEOUT_MS`: upstream Emby proxy timeout, default `30000`.
- `X_MUSIC_REQUEST_LOGS`: request logging to stdout for Docker/Dokploy logs. `auto` enables logs in production and leaves local `next dev` to Next's built-in request output; set `true` to force-enable locally or `false` to reduce production log volume. URLs are logged with sensitive token-like query values redacted.
- `EMBY_SOURCE_WEBDAV_DSN`: optional WebDAV destination for syncing finalized music files to the upstream Emby music library, for example `https://user:password@example.com/dav/music`. The DSN path should map to the same directory Emby reports for its music library, such as `/volume1/music`; XMusic preserves the relative `MUSIC_DATA_DIR/music` layout when uploading.
- `ADMIN_QQ_UINS`: QQ UIN allowlist for admin-only pages such as user management and jobs. Accepts comma, semicolon, or whitespace separated values.
- `WORKER_POLL_INTERVAL_MS`: idle worker polling interval, default `5000`.
- `WORKER_MAX_ATTEMPTS`: max job attempts before failure, default `3`.
- `TAGGING_WRITE_TAGS`: write supported file tags, default `true`.
- `TAGGING_FETCH_ONLINE_METADATA`: fetch QQ Music detail, lyrics, and cover metadata, default `true`.
- `TAGGING_ORGANIZE_FILES`: organize final files as `artist/album/artist - title.ext`, default `true`.
- `TAGGING_FETCH_TIMEOUT_MS`: network metadata/API timeout, default `5000`.
- `NEXT_PUBLIC_APP_NAME`: public UI label, default should be `XMusic`.
- `ANALYTICS_SCRIPT_CODE`: optional production-only analytics script tag. Set it to the complete `<script ...></script>` code provided by your analytics service.

## Architecture Notes

- Next.js serves the UI, API routes, and Emby-compatible gateway.
- The worker handles queued jobs using SQLite-backed job rows.
- QQ Music private APIs are used conservatively and must be treated as unstable.
- LX source scripts are loaded server-side. The browser never receives the script URL or key.
- The upstream Emby API key is a service credential. Player-facing passwords are maintained locally by XMusic.
- Generated QQ upstream Emby users are intentionally restricted to the music library only.

## Recent Changelog

### 2026-05-24

- Improved Narjo, Musiver, Subsonic, and ampcast compatibility for local Emby routes, including universal audio paths, lyrics/subtitle streams, image routes, and query/header token variants.
- Added local handling for more virtual QQ Music playback paths so compatible clients can request audio, lyrics, and artwork without leaking virtual IDs to the upstream Emby server.
- Aligned QQ lyric lookup with the LX playback flow and persisted fetched lyrics in the local cache for later tagging, sidecar generation, and client subtitle requests.
- Added WebDAV-based duplicate cleanup tooling for upstream Emby libraries, with dry-run/apply modes and optional deletion through Emby or WebDAV.
- Hardened Emby sync behavior around FLAC preference, exact path matching, empty directory pruning, stale jobs, and retry backoff.
- Moved ampcast into the same-origin `@player` flow and fixed embedded resource proxying so the homepage can open the player directly without URL-passed credentials.

### 2026-05-23

- Migrated QQ encrypted audio handling to the local UM crypto path, removing the need for an external decryption CLI in normal playback/cache flows.
- Reworked Emby virtual item mapping and playlist expansion for merged upstream Emby plus QQ Music library views.
- Added admin/runtime management improvements for users, jobs, account connection details, and runtime settings.
- Expanded automated coverage for Emby compatibility, cache reuse, job processing, QQ favorites/history, and admin infrastructure.

## Current Risks

- QQ private APIs still need live-account validation for every account-dependent endpoint.
- Real end-to-end playback and cache reuse depend on a working `LX_MUSIC_SOURCE_SCRIPT`.
- Emby scan/sync jobs require the upstream Emby server to see the same final music path layout.
- Existing ampcast sessions may keep using legacy IDs until the client refreshes its library view.
