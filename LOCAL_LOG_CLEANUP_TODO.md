# Local Log Cleanup TODO

This file tracks diagnostic logs that were added to make production/debug follow-up easier. Revisit these once the related behavior is stable, then either remove them, gate them more tightly, or convert them into permanent metrics.

## QQ Authorization Refresh

Added while investigating frequent QQ reauthorization prompts.

- `src/lib/qq/auth-refresh.ts`
  - Events: `qq_auth_refresh_attempt`, `qq_auth_refresh_success`, `qq_auth_refresh_failed`
  - Purpose: identify whether automatic refresh is being attempted, whether QQ returns a new musickey/token, and why refresh fails.
  - Cleanup: keep only failures if the aged-session refresh strategy proves stable.

- `src/lib/qq/auth-refresh.ts`
  - Event: `qq_auth_refresh_skipped`
  - Gate: `X_MUSIC_QQ_AUTH_REFRESH_LOG_SKIPS=1`
  - Purpose: inspect refresh decision reasons such as `fresh-session`, `outside-refresh-window`, or `recently-attempted`.
  - Cleanup: remove or keep gated; this can be noisy if enabled.

- `src/lib/qq/auth-state.ts`
  - Events: `qq_auth_check_after_refresh_success`, `qq_auth_check_rejected`, `qq_auth_check_retry_success`, `qq_auth_marked_expired`
  - Purpose: separate profile-check rejection from refresh failure and final expired marking.
  - Cleanup: keep `qq_auth_marked_expired`; consider removing success logs after enough real-account validation.

## Request Logging

Added for deployment debugging and anomalous response analysis.

- `src/lib/request-log.ts`
  - Gate: `X_MUSIC_REQUEST_LOGS`
  - Mode: `X_MUSIC_REQUEST_LOG_MODE=all|verbose` logs successful requests too.
  - Events: `http_request_start`, `http_request`, `http_response`
  - Purpose: diagnose routing, proxy source, status, response timing, range requests, and user agents.
  - Cleanup: keep error/anomalous logging; avoid enabling success logs by default.

## Music URL Resolution

Added while debugging playable URL resolution and source-script behavior.

- `src/lib/music-url/resolve.ts`
  - Gate: `X_MUSIC_MUSIC_URL_LOGS`; otherwise follows request logging.
  - Events: `music_url_resolve_candidates`, `music_url_resolve_attempt`, `music_url_resolve_failed`
  - Purpose: inspect source candidate selection, quality fallback, and failure reasons without logging full signed URLs.
  - Cleanup: keep failure logging; disable or remove candidate/attempt logs after source-script behavior is stable.

## Virtual Audio Playback

Added while debugging Emby/Ampcast/Narjo compatibility and virtual audio fallback paths.

- `src/lib/emby/local-handlers.ts`
  - Events include:
    - `external_emby_audio_proxy_failed`
    - `external_emby_audio_proxy_unusable`
    - `virtual_audio_metadata_missing`
    - `virtual_audio_playback_failed`
    - `virtual_audio_webdav_fallback_failed`
    - `virtual_audio_webdav_fallback_resolved`
    - `virtual_audio_mapped_fallback_proxy_failed`
    - `virtual_audio_mapped_fallback_proxy_unusable`
    - `virtual_audio_url_resolved`
    - `virtual_audio_quality_failed`
    - `virtual_audio_quality_skipped_unplayable_cache`
    - `virtual_audio_quality_retrying_stale_unplayable_cache`
  - Purpose: diagnose client-specific playback failures, stale unplayable cache, mapped-track fallback, WebDAV fallback, and quality fallback.
  - Cleanup: keep failed/unusable events; consider removing `virtual_audio_url_resolved` and successful fallback logs if production noise is high.

## Background Sync Debug Logs

Added for best-effort background paths where request failures should not break playback.

- `src/lib/qq/history.ts`
  - Gate: `X_MUSIC_DEBUG_BACKGROUND_SYNC=1`
  - Logs: `console.debug` for QQ play-history sync skipped, failed, or crashed.
  - Cleanup: keep gated or convert to `logServiceEvent` if it becomes operationally useful.

- `src/lib/emby/master.ts`
  - Gate: `X_MUSIC_DEBUG_BACKGROUND_SYNC=1`
  - Logs: `console.debug` for background Emby master/sync decisions.
  - Cleanup: keep gated while Emby sync behavior is still being tuned.

- `src/lib/emby/local-handlers.ts`
  - Gate: `X_MUSIC_DEBUG_BACKGROUND_SYNC=1`
  - Helper: `debugBackgroundSync`
  - Purpose: debug non-blocking Emby sync work triggered from local playback paths.
  - Cleanup: keep gated or fold into structured service events if needed.

## Not Currently Marked For Cleanup

These appear to be normal operational logs rather than temporary optimization/debug logs:

- `src/worker/index.ts` worker lifecycle/job logs.
- `src/lib/cache/*-job.ts` cache cleanup and UM crypto job result logs.
- `src/lib/tagging/job.ts`, `src/lib/tagging/inline.ts`, and Emby sync warning logs for actual failures.

## Review Checklist

- Confirm no log emits raw cookies, tokens, signed URLs, passwords, or full media URLs.
- Check production log volume after real-account QQ auth validation.
- Prefer keeping failed/anomalous events and removing success/attempt events.
- Keep environment-gated debug logs off by default.
