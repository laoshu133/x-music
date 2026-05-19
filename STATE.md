# miXmusic State

Last updated: 2026-05-19

## Goal

Build a private QQ Music web application with:

- Next.js as the web UI and backend API.
- Docker Compose deployment.
- QQ Music metadata for search, toplists, playlists, favorites, and later recommendations.
- LX custom-source compatible music URL resolution.
- Single upstream playback stream that is also cached locally.
- Post-download scraping/tagging through `xhongc/music-tag-web`.
- Local cache reuse before calling the music URL source again.

This is a personal/private application. Do not design for public multi-user distribution.

## Confirmed Decisions

- First release targets QQ Music only.
- `LX_MUSIC_URL_SCRIPT` is an LX custom-source compatible HTTP script.
- Do not implement an LX event sandbox. Construct the `musicUrl` request parameters directly and call the configured script URL from the server.
- Keep the real script URL/key only in `.env`; never expose it to the browser or commit it.
- Playback quality fallback order: `flac -> 320k -> 128k`.
- First uncached playback uses one upstream request:
  - prioritize forwarding chunks to the browser;
  - tee the same upstream chunks to a `.part` file;
  - if caching fails, playback should continue when possible.
- Uncached first-play seek support may be limited. Cached files should support proper HTTP Range playback.
- Database starts with SQLite.
- Design schema and data access so PostgreSQL can be introduced later.
- Do not use Redis in the first version. Use a SQLite-backed jobs table plus worker polling.
- `music-tag-web` runs as a sidecar container sharing `inbox` and `music` directories.
- `music-tag-web` integration strategy:
  - probe for usable HTTP API first;
  - if no stable API is confirmed, fall back to shared-directory scanning and polling.
- Chrome QA can be used for local UI checks; QQ Music visible login state was not confirmed on `https://y.qq.com/`.
- Every completed feature should be committed promptly.
- Sub-agent concurrency must stay at 3 or fewer.

## Current Repository State

Branch:

- `codex/mixmusic-initial`

Git:

- Repository has baseline commits on `codex/mixmusic-initial`.
- Current working tree has uncommitted feature work for local favorites, account API scaffolding, recommendations, and QA health status.

Observed files:

- `package.json`
- `package-lock.json`
- `next.config.ts`
- `tsconfig.json`
- `.env.example`
- `.gitignore`
- `Dockerfile`
- `docker-compose.yml`
- `README.md`
- `TODO.md`
- `src/`
- `data/`

Installed stack:

- Next.js 16
- React 19
- TypeScript
- `better-sqlite3`
- `zod`
- `pino`
- `music-metadata`
- `tsx`

Scripts currently defined:

- `npm run dev`
- `npm run build`
- `npm run start`
- `npm run worker`
- `npm run typecheck`
- `npm run test`

## Implemented / Scaffolded Areas

The current working tree appears to already contain an initial usable skeleton:

- Next.js app shell and web UI.
- API route for playback: `/api/play`.
- QQ Music metadata adapters:
  - song search;
  - toplist list/detail;
  - playlist search/detail.
- Playback route that:
  - checks cached files first;
  - resolves music URL with fallback quality;
  - streams upstream audio;
  - tees stream to local cache.
- SQLite persistence layer for tracks, track files, play events, and jobs.
- QQ account API:
  - `GET /api/account` reports configured server-side or locally stored QQ login state;
  - `POST /api/account/import` validates and stores QQ Music Cookie text by default;
  - `DELETE /api/account` clears the locally stored login state;
  - `QQ_MUSIC_COOKIE` remains supported as an env fallback.
- Local favorites layer:
  - `GET /api/favorites`;
  - `POST /api/favorites`;
  - `GET /api/favorites/status`;
  - SQLite `favorite_sync` rows stay local-first and `pending` until QQ remote sync is implemented.
- QQ remote favorites and recommendations:
  - `GET/POST/DELETE /api/favorites?remote=qq` are conservative private-endpoint wrappers;
  - `GET /api/favorites?sync=pull` pulls QQ favorite songs into local state;
  - `POST /api/favorites?sync=push` replays pending/failed local favorite changes to QQ;
  - `GET /api/recommendations` calls an experimental QQ radio/recommendation endpoint, then falls back to favorite-seeded search and public toplists;
  - both still require real authenticated-cookie validation.
- Playback URL resolution now downloads the LX script, parses `API_URL` and `API_KEY`, and calls `{API_URL}/music/url` directly. The old direct-script request shape remains as a compatibility fallback if no API config is exposed.
- QA health/status endpoint at `/api/health` reports database counts, cache directory access, job counts, local favorite sync counts, and missing config.
- Web client exposes song search, toplists, playlist search/detail, playback controls, local favorite/unfavorite, local favorites list, "猜你喜欢" entry point, and QA status view.
- Worker entrypoint for queued tagging jobs.
- `music-tag-web` sidecar Docker Compose service.
- Shared data directory layout:
  - `data/staging`
  - `data/inbox`
  - `data/music`
  - `data/music-tag-web`

Chrome QA on `http://localhost:3004` verified search rendering, local UI layout, and browser console health after the Impeccable-style frontend rebuild. Automated tests cover URL script parsing, job claiming, and cache ready-file state. Playback success, cache reuse, remote QQ account features, and Docker tagging remain unverified without a real `LX_MUSIC_URL_SCRIPT` and server-side QQ cookie.

## Known Blockers / Risks

- Chrome can be used to inspect visible y.qq.com login state, but the Chrome plugin security policy does not allow exporting browser cookies. Server-side QQ API verification still requires the user to paste a Cookie into the app or set `QQ_MUSIC_COOKIE`.
- QQ remote account APIs are implemented as conservative wrappers but not validated against a real logged-in `QQ_MUSIC_COOKIE`.
  - Favorite read likely needs `euin`/`enc_host_uin`.
  - Favorite write and recommendations use private endpoints that may change.
- Pending local favorite/unfavorite replay and QQ pull reconciliation are implemented but still need validation against a real cookie.
- Real `LX_MUSIC_URL_SCRIPT` end-to-end playback has not been verified.
- Current local repo only contains `.env.example` with `key=replace-me`; playback success and cache reuse are blocked until a real `.env` is provided.
- Single upstream tee behavior must be tested carefully:
  - browser disconnect;
  - partial Range request;
  - upstream failure;
  - disk write failure;
  - cache cleanup.
- `music-tag-web` API contract is not confirmed.
- Docker paths for `music-tag-web` may need adjustment after real container verification.

## Immediate TODO

1. Provide real local secrets for final acceptance.
   - Set `LX_MUSIC_URL_SCRIPT` in `.env` with the real script URL/key.
   - Paste a current y.qq.com Cookie into the app login panel or set `QQ_MUSIC_COOKIE`.

2. Verify QQ metadata APIs.
   - Song search returns normalized `MusicInfo`.
   - Toplist list/detail works.
   - Playlist search/detail works.

3. Verify LX music URL integration.
   - Keep real `LX_MUSIC_URL_SCRIPT` in local `.env`.
   - Confirm `flac -> 320k -> 128k` fallback.
   - Confirm missing/invalid script errors are actionable.

4. Verify playback and cache.
   - First play streams successfully.
   - First play creates `.part`, then inbox file.
   - Second play uses local cached file and does not call `LX_MUSIC_URL_SCRIPT`.
   - Cached local file supports Range requests.

5. Verify worker and tagging.
   - `tag_track_file` jobs are created.
   - Worker claims jobs.
   - Worker marks files `ready` or `failed` correctly.
   - Confirm whether `music-tag-web` has usable HTTP API.
   - If not, validate shared-directory polling.

6. Verify and harden QQ account features.
   - Provide real `QQ_MUSIC_COOKIE` with required encrypted UIN data.
   - Verify remote favorite read.
   - Verify favorite/unfavorite write.
   - Verify "猜你喜欢" response mapping.
   - Verify pending local favorite sync API.
   - Verify reconciliation where QQ remote state wins.

## Suggested Sub-Agent Split

Run no more than 3 agents concurrently.

### Agent A - QQ Data Adapter

Ownership:

- `src/lib/qq/**`
- QQ-related API routes under `src/app/api/**`

Responsibilities:

- Verify and harden QQ song search.
- Verify and harden toplists.
- Verify and harden playlist search/detail.
- Later: login-state import, favorites, and recommendations.

### Agent B - Playback and Cache Core

Ownership:

- `src/lib/music-url/**`
- `src/lib/cache/**`
- `/api/play`
- SQLite cache state transitions.

Responsibilities:

- Direct HTTP integration with LX custom-source script.
- Quality fallback.
- Single upstream tee.
- Local cached playback with Range.
- Cache mapping and cleanup behavior.

### Agent C - Worker, Docker, and Tagging

Ownership:

- `src/worker/**`
- `src/lib/jobs/**`
- `src/lib/tagging/**`
- `Dockerfile`
- `docker-compose.yml`
- docs/env examples.

Responsibilities:

- SQLite job worker.
- `music-tag-web` probe and fallback integration.
- Docker Compose validation.
- Data directory and permission handling.

## Monitoring Plan

Main thread should act as integrator:

- Keep a short plan with current owner/status.
- Review each sub-agent patch before merging.
- Run typecheck/build after each integration.
- Commit after each independently working feature.
- Avoid overlapping writes between agents.
- Keep `STATE.md` updated when architecture or implementation status changes.
