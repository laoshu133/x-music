# XMusic

XMusic (code: `x-music`) is a private QQ Music to Emby-compatible gateway. It lets Emby-compatible players, especially ampcast, browse and play QQ Music virtual content, with optional upstream Emby merge and sync.

The app is for personal/private deployment. It is not designed as a public multi-user music service.

## Core Features

- QQ Music account access with QR-code login or pasted y.qq.com Cookie. Each QQ account gets a local Emby gateway account using the normalized username `QQ${QQ_UID}`.
- Emby-compatible music gateway for ampcast and other clients. XMusic exposes authentication, user views, a virtual music library, merged songs/albums/playlists/genres, favorites, most-played and recently-played lists, artwork routes, lyrics/subtitle routes, and QQ virtual audio playback from the service root.
- Optional merged upstream Emby and QQ Music library views. Real Emby music items are proxied from the configured upstream server, while QQ playlists, albums, recommendations, top lists, favorites, and play history are expanded into virtual Emby-compatible items. Without upstream Emby, the local gateway still supports player login, browsing, and QQ virtual playback.
- Private local playback cache and archive pipeline. Non-encrypted QQ/LX audio URLs are returned to clients with a 302 redirect. Encrypted QQ audio is cached locally and decrypted as a stream. Playback completion and favorite actions enqueue archive jobs that transfer songs, lyrics, and covers into the local library.
- Metadata and library organization pipeline. Background workers handle archive downloads, tagging, lyric and cover collection, file organization, Emby-friendly sidecar generation, duplicate cleanup, and optional upstream Emby/WebDAV sync.
- Optional restricted upstream Emby account binding. When upstream Emby is configured, generated upstream users are limited to the music library, with channel access, remote control, and shared device control disabled.
- SQLite-backed persistence for accounts, tracks, cached files, jobs, play events, favorites, virtual items, remote mappings, and runtime settings.
- Management UI and APIs for login, connection information, runtime configuration, user administration, job status, health checks, and cache/job visibility.

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

Emby itself is optional and is no longer started by this project. If you want
to merge or sync with an upstream Emby library, run Emby separately and save
that server URL in each user's account Emby config. The saved URL must be
reachable from the XMusic container. Use `host.docker.internal` for a
host-machine Emby service where supported, or a LAN/reverse-proxy address for
another machine.

For Emby sync jobs, configure the upstream Emby music library or WebDAV target
so it can see the same final organized music path layout produced under
XMusic's shared data directory.

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

Each user can also configure their own upstream Emby server URL, API key,
WebDAV storage DSN, and proxy timeout in the same account Emby config. These
values are stored per account, not in `.env`.

The exposed virtual music library uses `x-music-music`.

## Environment

Required:

- `LX_MUSIC_SOURCE_SCRIPT`: LX Music custom source script URL for playback URL resolution.

Optional:

- `DATABASE_URL`: SQLite database URL, default `file:./data/app.sqlite`.
- `MUSIC_DATA_DIR`: shared music data root, default `./data`.
- `PORT`: production/server port, default deployment value `8098`; local `npm run dev` uses `3004`.
- `AMPCAST_PORT`: optional host port for the bundled ampcast container in Docker Compose, default `8000`.
- `AMPCAST_URL`: optional ampcast upstream URL for XMusic's same-origin `/@player` proxy, default `http://ampcast:8000/`. Local npm development can use `http://127.0.0.1:8000/`.
- `X_MUSIC_REQUEST_LOGS`: request logging to stdout for Docker/Dokploy logs. `auto` enables logs in production and leaves local `next dev` to Next's built-in request output; set `true` to force-enable locally or `false` to reduce production log volume. URLs are logged with sensitive token-like query values redacted.
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
- Upstream Emby URL, API key, WebDAV DSN, and proxy timeout are per-account settings managed from the UI. Player-facing passwords and access tokens are maintained locally by XMusic.
- QQ login state is authoritative. When the stored QQ authorization expires, account-dependent XMusic and Emby-compatible endpoints return `401` with `QQ_AUTH_EXPIRED` until QQ authorization is completed again.
- Generated QQ upstream Emby users are intentionally restricted to the music library only when upstream Emby is configured.

## Current Risks

- Real end-to-end playback and cache reuse depend on a working `LX_MUSIC_SOURCE_SCRIPT`.
- Emby scan/sync jobs require optional upstream Emby or WebDAV configuration and the upstream server to see the same final music path layout.
- Existing ampcast sessions may keep using legacy IDs until the client refreshes its library view.
