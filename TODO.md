# miXmusic Product TODO

## P0 - Test Environment Acceptance

- [x] QQ song search API returns playable metadata.
- [x] QQ toplist API returns boards and board songs.
- [x] QQ playlist search/detail API returns playlist songs.
- [x] Playback API resolves music URL, streams to browser, and caches to local storage.
- [x] SQLite job worker can claim tag jobs and mark cached files ready.
- [x] Web client exposes song search, toplists, playlist search/detail, and playback controls.
- [x] Web client exposes local favorite/unfavorite, local favorites list, recommendations entry, and QA status view.
- [x] Local favorites API records pending favorite/unfavorite sync state.
- [x] Health API reports database, cache directory, job, favorite, and missing config status.
- [ ] End-to-end playback with the real `LX_MUSIC_URL_SCRIPT` source is verified.
- [ ] End-to-end cache reuse is verified: second play reads local file instead of resolving URL again.
- [ ] End-to-end `music-tag-web` shared-directory scraping is verified in Docker Compose.

## P1 - QQ Account Features

- [x] QQ Music cookie-shape validation/import endpoint.
- [x] Conservative QQ remote favorite read/write API entry points.
- [x] Conservative QQ "猜你喜欢" recommendations API entry point.
- [x] Local QQ login persistence and logout flow.
- [x] API/UI entry points for pulling QQ favorites and pushing pending local changes.
- [ ] Verify QQ account APIs with a real logged-in `QQ_MUSIC_COOKIE` including `euin`/`enc_host_uin`.
- [ ] Verify local pending favorite/unfavorite actions sync back to QQ Music with a real cookie.
- [ ] Verify reconciliation: QQ remote favorite state wins and local pending operations are replayed.

## P2 - Hardening

- [x] Improve `/api/play` API-level error reporting for missing `LX_MUSIC_URL_SCRIPT`.
- [x] Align Docker standalone output with `node .next/standalone/server.js`.
- [x] Add automated tests for URL resolution, job claiming, and cache state transitions.
- [ ] Add admin UI for cache/job status and failed job retry.
