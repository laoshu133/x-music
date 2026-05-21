# XMusic Product TODO

## P0 - Test Environment Acceptance

- [x] QQ song search API returns playable metadata.
- [x] QQ toplist API returns boards and board songs.
- [x] QQ playlist search/detail API returns playlist songs.
- [x] Playback API resolves music URL, streams to browser, and caches to local storage.
- [x] SQLite job worker can claim tag jobs and mark cached files ready.
- [x] Web client exposes song search, toplists, playlist search/detail, and playback controls.
- [x] Web client exposes local favorite/unfavorite, local favorites list, recommendations entry, and QA status view.
- [x] Web client exposes recent playback history and replay from history.
- [x] Local favorites API records pending favorite/unfavorite sync state.
- [x] Local playback history API returns recent play events from SQLite.
- [x] Health API reports database, cache directory, job, favorite, and missing config status.
- [ ] End-to-end playback with the real `LX_MUSIC_SOURCE_SCRIPT` source is verified.
- [x] API-level cache reuse checks `ready`, `tagging`, `cached_raw`, and cached failed-tag files before resolving a new URL.
- [ ] End-to-end local playback history is verified after real playback.
- [x] Built-in tagging uses deterministic library paths, records tagged sidecars in SQLite, and writes Emby-friendly cover/lyrics files when metadata is available.
- [ ] End-to-end cache reuse is verified with real browser playback and the real `LX_MUSIC_SOURCE_SCRIPT`.
- [ ] End-to-end built-in tagging is verified against real MP3/FLAC playback files and an Emby scan.

## P1 - QQ Account Features

- [x] QQ Music cookie-shape validation/import endpoint.
- [x] Conservative QQ remote favorite read/write API entry points.
- [x] Conservative QQ "猜你喜欢" recommendations API entry point.
- [x] Local QQ login persistence and logout flow.
- [x] API/UI entry points for pulling QQ favorites and pushing pending local changes.
- [x] QQ扫码登录 API and UI flow based on `sansenjian/qq-music-api`.
- [x] QQ用户头像 API and logged-in avatar display.
- [x] QQ用户歌单 API and "我的歌单" browser in the playlist view.
- [x] Conservative QQ play-history sync wrapper called after successful local playback start.
- [ ] Verify QQ account APIs with a real logged-in `QQ_MUSIC_COOKIE` including `euin`/`enc_host_uin`.
- [ ] Verify QR login end-to-end with a real QQ scan and confirm the returned cookie has the keys required by favorites.
- [ ] Verify QQ user playlists with a real logged-in account and private/created playlist variants.
- [ ] Verify local pending favorite/unfavorite actions sync back to QQ Music with a real cookie.
- [ ] Verify QQ play-history write sync with a real logged-in account and captured QQ Music player traffic.
- [ ] Verify reconciliation: QQ remote favorite state wins and local pending operations are replayed.

## P2 - Hardening

- [x] Improve `/api/play` API-level error reporting for missing `LX_MUSIC_SOURCE_SCRIPT`.
- [x] Align Docker standalone output with `node .next/standalone/server.js`.
- [x] Add automated tests for URL resolution, tagging, job claiming, and cache state transitions.
- [ ] Add admin UI for cache/job status and failed job retry.

## Reference API Coverage Gaps

- [ ] Music detail APIs from `sansenjian/qq-music-api`: lyric, song info, batch song info, MV play/detail.
- [ ] Discovery APIs: hot key, smartbox, radio lists, new disks, playlist categories/tags, batch playlist detail.
- [ ] Singer APIs: singer list, singer detail/description, hot songs, albums, MV, similar singers, star count.
- [ ] Album/comment/digital album APIs.
- [ ] Compatibility routes using the upstream naming style such as `/getQQLoginQr`, `/checkQQLoginQr`, and `/user/getUserPlaylists`.
