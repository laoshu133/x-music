# XMusic State

Last updated: 2026-05-22

- Project name: XMusic
- Code name: `x-music`
- Default server port: `8098`

## Goal

Build a private QQ Music to Emby gateway with:

- QQ Music login, metadata, favorites, playlists, recommendations, and play-history integration.
- LX custom-source compatible playback URL resolution.
- Local playback cache, tagging, lyrics/cover sidecars, and Emby-scannable file output.
- Emby-compatible gateway endpoints so ampcast can browse and play a merged upstream Emby + QQ Music library.
- Per-QQ gateway accounts, with safe upstream Emby user binding and restricted permissions.

This remains a personal/private application. Do not optimize for public multi-tenant operation.

## Current Branch / Repository

- Working directory: `/Users/xiaomi/projects/XMusic`
- Historical branch: `codex/x-music-initial`
- Current rename target: XMusic / `x-music`
- Current working tree contains uncommitted feature work and docs/config updates.

## Implemented

- Next.js 16 + React 19 application shell.
- Default local and container web port changed to `8098`.
- Package name changed to `x-music`.
- Docker image name changed to `x-music-app:latest`.
- XMusic branding is reflected in UI, metadata, Emby server info, worker logs, README, and `.env.example`.
- Canonical Emby gateway path is `/x-music/emby`.
- Fallback Emby-style route rewriting now targets `/x-music/emby`.

## Emby Gateway Progress

- Local Emby authentication is implemented.
- One account is created per QQ login.
- Gateway usernames are normalized as `QQ${QQ_UID}`.
- Existing upstream Emby users are looked up by saved `embyUserId` first, then by username.
- Existing bound upstream users are renamed to the normalized `QQ${QQ_UID}` name when needed.
- Upstream Emby user policy is reapplied on bind/login:
  - non-admin;
  - all channels disabled;
  - remote control disabled;
  - shared device control disabled;
  - all folders disabled except the music library;
  - music library detection supports `CollectionType=music`, `音乐`, and `Music`.
- Local user views expose the XMusic virtual music collection as `x-music-music`.
- Search/list/favorites/recent/played endpoints merge upstream Emby items with QQ virtual items.
- QQ virtual playlist, album, genre, image, item-detail, audio, and playback-report paths are handled locally.
- Virtual IDs no longer leak to upstream Emby for playlist items, item details, audio HEAD, or playback report requests.
- Real upstream Emby image requests proxy correctly.

## QQ Music Progress

- QR login API and UI are implemented.
- Cookie import and logout are implemented.
- Account state summary and avatar lookup are implemented.
- QQ song search, playlist search/detail, user playlists, recommendations, favorite songs, favorite albums, and play-history sync wrappers exist.
- QQ list fetches have been audited to use `StartIndex + Limit` windows and capped upstream page sizes:
  - QQ song page size cap: `100`;
  - QQ playlist page size cap: `50`;
  - Emby-facing list cap: `1000`.
- My Songs can page beyond the earlier 200-song cap.
- The local database was cleaned of `History Test`; latest verified count was `0`.

## Playback / Cache / Tagging Progress

- `/api/play` can resolve LX music URLs, stream to the client, and tee to local cache.
- Playback quality fallback order is `flac -> 320k -> 128k`.
- Cache reuse checks ready, tagging, cached raw, and failed-tag-but-playable files before resolving a new upstream URL.
- Cached local playback supports Range requests.
- Local play events are recorded.
- QQ play-history sync is best-effort and non-blocking.
- Worker can claim, complete, fail, and retry SQLite jobs.
- Built-in tagging writes deterministic final paths, metadata tags where supported, lyrics, and cover sidecars.
- Emby sync jobs are queued after QQ virtual audio playback and tagging/cache events where applicable.

## API / UI Progress

- Management UI is focused on QQ login, Emby connection details, runtime config, ampcast launch, and health/status.
- Health endpoint reports database counts, cache directory access, job counts, favorite sync counts, and missing config.
- Runtime config supports QQ feature toggles while keeping upstream Emby credentials environment-owned.
- Account Emby password can be viewed/updated through account-specific config.

## Verified

- `npm run typecheck` passed after the latest account-binding work.
- `npm test` passed after the latest account-binding work: 50 tests passed.
- `git diff --check` passed after the latest account-binding work.
- Tests cover:
  - QQ login account creation with `QQ${QQ_UID}`;
  - upstream Emby user creation, rename, and restricted policy;
  - local Emby authentication;
  - CORS;
  - upstream proxy header cleanup;
  - merged search/favorites/playlists/genres/played lists;
  - QQ pagination caps;
  - virtual playlist expansion;
  - virtual item details/audio/playback reports;
  - image proxying;
  - cache, job, LX URL, QQ favorite/history, and tagging behavior.

## Known Risks

- QQ private endpoints are unstable and require live-account validation.
- QR login success does not guarantee all private QQ endpoints receive every key they need; favorites may require encrypted UIN fields.
- Real end-to-end playback depends on a valid `LX_MUSIC_SOURCE_SCRIPT`.
- Emby library refresh/sync requires the upstream Emby server to scan the same organized music directory or an equivalent mounted path.
- The local `.env` file is intentionally ignored and may still contain old display names or local-only values.

## Immediate TODO

1. Verify the renamed service on `http://localhost:8098`.
2. In ampcast, connect to `http://localhost:8098` or `http://localhost:8098/x-music/emby`.
3. Confirm login with username `QQ${QQ_UID}` and generated account password.
4. Re-check My Songs, My Albums, Most Played, Recently Played, playlists, search, and image loading after the XMusic rename.
5. Verify one real QQ virtual song playback end-to-end:
   - audio starts;
   - local cache file is written;
   - play event is recorded;
   - Emby sync job is queued;
   - upstream Emby eventually sees the transferred/tagged file after scan.
6. Validate upstream Emby user permissions in the Emby admin UI:
   - only the music library is visible;
   - channel access is off;
   - remote control permissions are off.

## Later TODO

- Add a visible admin page for job retry and failed cache cleanup.
- Verify QQ favorites write, play-history write, and recommendation endpoints with a current live QQ account.
- Verify Docker deployment with real mounts and upstream Emby scan paths.
