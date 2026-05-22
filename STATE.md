# XMusic State

Last updated: 2026-05-22

- Project name: XMusic
- Code name: `x-music`
- Previous name: `miXmusic`
- Default local development port: `3004`
- Default production/deployment port: `8098`
- Working directory: `/Users/xiaomi/projects/x-music`
- Current branch: `master`
- Current upstream: `origin/master`

## Product Goal

XMusic is a private QQ Music to Emby gateway. It lets Emby-compatible players, especially ampcast, browse and play a merged music library backed by an upstream Emby server plus QQ Music virtual content.

The project is for personal/private deployment. Do not optimize for public multi-tenant operation.

## Migration Status

- The active product name is `XMusic`.
- The active package/code name is `x-music`.
- The canonical Emby gateway is the service root (`/`).
- Legacy `/mixmusic/emby` and `/x-music/emby` compatibility is intentionally not maintained.
- The virtual music library ID is `x-music-music`.
- The account session cookie is `x_music_account`.
- The gateway source response header is `x-x-music-source`.
- Default local development port is `3004`.
- Default Docker and production web port is `8098`.
- Source scan after migration found no old `mixmusic`/`miXmusic` naming in tracked app source or docs.

## Implemented

- Next.js 16 + React 19 application shell.
- Docker image name is `x-music-app:latest`.
- XMusic branding is reflected in UI, metadata, Emby server info, worker logs, README, and `.env.example`.
- Root-level Emby-style HTTP routes are handled by `src/app/[...path]/route.ts`.
- Management UI is focused on QQ login, Emby connection details, runtime config, ampcast launch, and status checks.

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
  - music library detection supports `CollectionType=music`, `音乐`, and `Music`;
  - Emby user access policy writes both the music library `Guid` and `ItemId` when available, because Emby Web's access-page checkboxes use `Guid` while music browsing URLs use `ItemId`/parentId.
- Music library permission detection now falls back from `/Library/VirtualFolders` to Emby `CollectionFolder` items, covering sources where the music library URL parentId appears as `ItemId`/`Id` such as `11696830`.
- Applying a restricted upstream user policy fails fast if no music library id can be found, instead of saving a user with no folder permissions.
- After applying the restricted upstream user policy, XMusic reads the upstream user back and verifies `EnableAllFolders=false` and that at least one discovered music library access id is present in `EnabledFolders`; login returns a 502 instead of silently succeeding if binding or verification fails.
- Local user views expose the XMusic virtual music collection as `x-music-music`.
- The discovered upstream music library mapping is cached on login/bind:
  - `parentIds` drive `x-music-music` to upstream Emby list/proxy `ParentId` mapping;
  - `policyIds` drive upstream Emby user `EnabledFolders` permissions.
- Search/list/favorites/recent/played endpoints merge upstream Emby items with QQ virtual items.
- QQ virtual playlist, album, genre, image, item-detail, audio, and playback-report paths are handled locally.
- Virtual IDs no longer leak to upstream Emby for playlist items, item details, audio HEAD, or playback report requests.
- Ampcast-style artist collection requests such as `/Artists/AlbumArtists?ParentId=x-music-music` are handled as local collection requests and fall back to empty collections if upstream Emby rejects them.
- Real upstream Emby image requests proxy correctly.

## QQ Music Progress

- QR login API and UI are implemented.
- Cookie import and logout are implemented.
- Account state summary and avatar lookup are implemented.
- QQ song search, playlist search/detail, user playlists, recommendations, favorite songs, favorite albums, and play-history sync wrappers exist.
- QQ list fetches use `StartIndex + Limit` windows and capped upstream page sizes:
  - QQ song page size cap: `100`;
  - QQ playlist page size cap: `50`;
  - Emby-facing list cap: `1000`.
- My Songs can page beyond the earlier 200-song cap.

## Playback / Cache / Tagging Progress

- `/api/play` can resolve LX music URLs, stream to the client, and tee to local cache.
- Playback quality fallback order is `flac -> 320k -> 128k`.
- Cache reuse checks ready, tagging, cached raw, and failed-tag-but-playable files before resolving a new upstream URL.
- Concurrent virtual-audio requests wait briefly for an active cache write before resolving and pulling the source again.
- Cached local playback supports Range requests.
- QQ/LX-derived resource fetches for artwork, lyrics, metadata, and LX source scripts are cached as local files under `data/resources`.
- QQ virtual artwork requests through the Emby gateway are served from the resource cache after the first source fetch.
- Local play events are recorded.
- QQ play-history sync is best-effort and non-blocking.
- Worker can claim, complete, fail, and retry SQLite jobs.
- Emby sync jobs fail after max attempts when no cached media file becomes available instead of staying queued forever.
- Emby sync jobs no longer complete successfully when a library scan is triggered but the synced track cannot be found in upstream Emby; they requeue or fail with a visible error.
- Emby sync success removes related cached QQ artwork and lyric source files once the track is mapped to Emby.
- Built-in tagging writes deterministic final paths, metadata tags where supported, lyrics, and cover sidecars.
- Emby sync jobs are queued after QQ virtual audio playback and tagging/cache events where applicable.

## API / UI Progress

- Health endpoint reports database counts, cache directory access, job counts, favorite sync counts, and missing config.
- Health/status UI was refactored into an operations dashboard with dependency, job, resource-cache, directory, and sync summaries.
- `/api/jobs` exposes job summary and recent job records.
- The UI includes a dedicated task list page reachable from the status page and sidebar.
- Runtime config supports QQ feature toggles while keeping upstream Emby credentials environment-owned.
- Account Emby password can be viewed/updated through account-specific config.
- UI copy now describes gateway usernames as `QQ + 当前 QQ 号`, matching the `QQ${QQ_UID}` implementation.
- QQ song virtual IDs are now stable across My Songs, My Albums, and Playlists to reduce duplicate virtual tracks in clients.

## Verified

- `npm test` passed on 2026-05-22: 58 tests passed.
- `npm run build` passed on 2026-05-22.
- Chrome verification on 2026-05-22 confirmed that upstream Emby Web only checks the music library access box when `EnabledFolders` contains the music library `Guid` (`0bdce3b2639a4626a99b334b6204f569` in the current source), while `11696830` remains the browsing parentId.
- Current build output includes `/api/jobs` and the root-level catch-all Emby gateway route.
- `git status --short --branch` was clean before this state-update task.
- Tests cover:
  - QQ login account creation with `QQ${QQ_UID}`;
  - upstream Emby user creation, rename, and restricted policy;
  - upstream Emby user policy verification failure when the written policy does not include the music library;
  - upstream Emby music library permission fallback through CollectionFolder ids and `Guid`-based access ids;
  - local `x-music-music` parent mapping to the cached upstream music library id;
  - local Emby authentication;
  - CORS;
  - upstream proxy header cleanup;
  - merged search/favorites/playlists/genres/played lists;
  - QQ pagination caps;
  - virtual playlist expansion;
  - virtual item details/audio/playback reports;
  - image proxying;
  - Ampcast `/Artists/AlbumArtists` collection compatibility;
  - resource cache hits for QQ virtual artwork;
  - stable QQ song virtual IDs across playlists;
  - cache, job, LX URL, QQ favorite/history, and tagging behavior.
  - Emby sync failure when scan completes but no upstream item is found.

## Known Risks

- QQ private endpoints are unstable and require live-account validation.
- QR login success does not guarantee all private QQ endpoints receive every key they need; favorites may require encrypted UIN fields such as `euin` or `enc_host_uin`.
- Real end-to-end playback depends on a valid `LX_MUSIC_SOURCE_SCRIPT`.
- Emby library refresh/sync requires the upstream Emby server to scan the same organized music directory or an equivalent mounted path.
- The local `.env` file is intentionally ignored and may contain local-only values.

## TODO

### P0 - Real Environment Acceptance

- Verify the renamed service locally on `http://localhost:3004` and in deployment on `http://localhost:8098`.
- In ampcast local development, connect to `http://localhost:3004`.
- In ampcast deployment, connect to `http://localhost:8098`.
- Confirm login with username `QQ${QQ_UID}` and generated account password.
- Re-check My Songs, My Albums, Most Played, Recently Played, playlists, search, and image loading after the XMusic rename.
- Verify one real QQ virtual song playback end-to-end:
  - audio starts;
  - local cache file is written;
  - play event is recorded;
  - Emby sync job is queued;
  - upstream Emby eventually sees the transferred/tagged file after scan.
- Verify end-to-end local audio and resource cache reuse with real browser playback and the real `LX_MUSIC_SOURCE_SCRIPT`.
- Verify built-in tagging against real MP3/FLAC playback files and an Emby scan.
- Validate upstream Emby user permissions in the Emby admin UI:
  - only the music library is visible;
  - channel access is off;
  - remote control permissions are off.

### P1 - QQ Account Validation

- Verify QQ account APIs with a real logged-in `QQ_MUSIC_COOKIE` including `euin` or `enc_host_uin`.
- Verify QR login end-to-end with a real QQ scan and confirm the returned cookie has the keys required by favorites.
- Verify QQ user playlists with a real logged-in account and private/created playlist variants.
- Verify local pending favorite/unfavorite actions sync back to QQ Music with a real cookie.
- Verify QQ play-history write sync with a real logged-in account and captured QQ Music player traffic.
- Verify reconciliation: QQ remote favorite state wins and local pending operations are replayed.
- Verify QQ recommendations with a current live QQ account.

### P2 - Product Hardening

- Add failed job retry controls and failed cache cleanup actions to the task/status UI.
- Verify Docker deployment with real mounts and upstream Emby scan paths.

### Reference API Coverage Gaps

- Music detail APIs from `sansenjian/qq-music-api`: lyric, song info, batch song info, MV play/detail.
- Discovery APIs: hot key, smartbox, radio lists, new disks, playlist categories/tags, batch playlist detail.
- Singer APIs: singer list, singer detail/description, hot songs, albums, MV, similar singers, star count.
- Album/comment/digital album APIs.
- Compatibility routes using the upstream naming style such as `/getQQLoginQr`, `/checkQQLoginQr`, and `/user/getUserPlaylists`.
