# miXmusic Product TODO

## P0 - Test Environment Acceptance

- [x] QQ song search API returns playable metadata.
- [x] QQ toplist API returns boards and board songs.
- [x] QQ playlist search/detail API returns playlist songs.
- [x] Playback API resolves music URL, streams to browser, and caches to local storage.
- [x] SQLite job worker can claim tag jobs and mark cached files ready.
- [ ] Web client exposes song search, toplists, playlist search/detail, and playback controls.
- [ ] End-to-end playback with the real `LX_MUSIC_URL_SCRIPT` source is verified.
- [ ] End-to-end cache reuse is verified: second play reads local file instead of resolving URL again.
- [ ] End-to-end `music-tag-web` shared-directory scraping is verified in Docker Compose.

## P1 - QQ Account Features

- [ ] QQ Music login state capture/import.
- [ ] Read QQ favorite songs.
- [ ] Sync local favorite/unfavorite actions back to QQ Music.
- [ ] Periodic reconciliation: QQ remote favorite state wins, local pending operations are replayed.
- [ ] Explore and implement QQ Music "猜你喜欢" recommendations.

## P2 - Hardening

- [ ] Improve `/api/play` error reporting for missing `LX_MUSIC_URL_SCRIPT`.
- [ ] Align Docker standalone output with `node .next/standalone/server.js`.
- [ ] Add automated tests for URL resolution, job claiming, and cache state transitions.
- [ ] Add admin UI for cache/job status and failed job retry.
