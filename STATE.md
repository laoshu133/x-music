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
- Temporarily ignore Chrome plugin/login-state validation issues and continue implementation.
- Every completed feature should be committed promptly.
- Sub-agent concurrency must stay at 3 or fewer.

## Current Repository State

Branch:

- `codex/mixmusic-initial`

Git:

- Repository has no commits yet.
- There are uncommitted scaffold files and dependencies already present.

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
- Worker entrypoint for queued tagging jobs.
- `music-tag-web` sidecar Docker Compose service.
- Shared data directory layout:
  - `data/staging`
  - `data/inbox`
  - `data/music`
  - `data/music-tag-web`

These areas still need verification before being treated as complete.

## Known Blockers / Risks

- Chrome plugin could not be used in this thread to validate existing QQ Music login state.
  - Prior separate Codex thread successfully used the Chrome plugin and saw `https://y.qq.com/`.
  - Current thread had `agent.browsers.list() -> []`.
  - User approved ignoring this for now.
- QQ account features are not yet implemented:
  - login state import/capture;
  - favorite songs read;
  - favorite/unfavorite sync back to QQ Music;
  - recommendations / "猜你喜欢".
- Real `LX_MUSIC_URL_SCRIPT` end-to-end playback has not been verified.
- Single upstream tee behavior must be tested carefully:
  - browser disconnect;
  - partial Range request;
  - upstream failure;
  - disk write failure;
  - cache cleanup.
- `music-tag-web` API contract is not confirmed.
- Docker paths for `music-tag-web` may need adjustment after real container verification.

## Immediate TODO

1. Stabilize and commit the current project skeleton.
   - Run `npm run typecheck`.
   - Run `npm run build`.
   - Fix any compile/runtime issues.
   - Commit the baseline scaffold.

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

6. Implement QQ account features after core playback works.
   - Login state import/capture.
   - Read favorite songs.
   - Local favorite/unfavorite pending queue.
   - Sync pending operations back to QQ.
   - Periodic reconciliation where QQ remote state wins.
   - Explore "猜你喜欢" endpoint and treat it as experimental.

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

