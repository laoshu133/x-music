# miXmusic

Private QQ Music web player with LX-compatible music URL resolution, local caching, and music-tag-web scraping.

## Development

```bash
cp .env.example .env
npm run dev
```

## Architecture

- Next.js serves the UI and API routes.
- A Node worker handles background jobs using SQLite-backed job rows.
- `music-tag-web` runs as a sidecar and shares the `data/inbox` and `data/music` directories.
- First release targets QQ Music only.

## Cache Flow

1. Resolve a playable URL through `LX_MUSIC_URL_SCRIPT`.
2. Stream the single upstream response to the browser first.
3. Tee the same stream to `data/staging/*.part`.
4. Move completed files to `data/inbox`.
5. Let `music-tag-web` scrape and organize files into `data/music`.
6. Store `source + songmid + quality -> finalPath` mappings in SQLite.
