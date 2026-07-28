# Local Log Cleanup TODO

This file tracks diagnostic logs that were added to make production/debug follow-up easier. Revisit these once the related behavior is stable, then either remove them, gate them more tightly, or convert them into permanent metrics.

## QQ Authorization Refresh

Added while investigating frequent QQ reauthorization prompts.

- `src/lib/qq/auth-refresh.ts`
  - Event: `qq_auth_refresh_failed`
  - Purpose: retain automatic refresh failures and the upstream error summary.
  - Policy: keep as an error event.

- `src/lib/qq/auth-refresh.ts`
  - Event: `qq_auth_refresh_skipped`
  - Gate: `X_MUSIC_QQ_AUTH_REFRESH_LOG_SKIPS=1`
  - Purpose: inspect refresh decision reasons such as `fresh-session`, `outside-refresh-window`, or `recently-attempted`.
  - Cleanup: remove or keep gated; this can be noisy if enabled.

- `src/lib/qq/auth-state.ts`
  - Events: `qq_auth_expired_recheck_attempt`, `qq_auth_refresh_degraded`, `qq_auth_marked_expired`, `qq_auth_expired_response`
  - Purpose: separate automatic expired-account recovery, transient degraded operation, and final expired marking.
  - Policy: keep degraded/expired logs; the successful refresh event has been removed.

- `src/lib/qq/auth-sweep.ts`
  - Events: `qq_auth_sweep_completed`, `qq_auth_sweep_account_failed`
  - Gate: healthy zero-change summaries require `X_MUSIC_QQ_AUTH_SWEEP_LOG_HEALTHY=1`; expired or failed results are always logged when service logging is enabled.
  - Purpose: verify that the worker proactively checks and renews stored QQ sessions even without website traffic.
  - Cleanup: keep account failures and the healthy-summary gate.

- `src/lib/qq/http.ts` and `src/app/initial-account.ts`
  - Events: `qq_music_error_response`, `qq_music_unhandled_error`, `initial_account_load_failed`
  - Purpose: retain backend diagnostics while clients receive a generic friendly system-error message.
  - Cleanup: permanent error logs are useful; revisit payload fields to keep them minimal.

## QQ QR Login

Added after the first scan after redeploy showed a login failed prompt while the second scan succeeded.

- `src/lib/qq/user.ts`
  - Event: `qq_login_failed`
  - Purpose: retain a summarized failure without logging QR progress, cookies, or successful authorization stages.
  - Policy: keep as an error event.

## QQ Recommendations

Added while investigating slow or incomplete personalized recommendation loads.

- `src/lib/qq/recommendations.ts`
  - Event: `qq_recommendations_loaded`
  - Default: emitted only when a load reaches `QQ_RECOMMENDATION_SLOW_LOG_MS` (default 5 seconds) or returns partial results after a timeout.
  - Purpose: record batch count, duration, result count, and stop reason without logging song data or request credentials.
  - Policy: keep the slow-load threshold; normal successful loads stay quiet.

- `src/lib/emby/local-handlers.ts`
  - Event: `qq_recommendation_pool_extend_failed`
  - Purpose: retain failures from the best-effort recommendation pool while allowing cached results to be returned.
  - Cleanup: keep as an error event.

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
  - Events: failed `music_url_resolve_attempt` and final `music_url_resolve_failed`
  - Purpose: inspect source failure reasons and quality fallback without logging successful lookups or signed URLs.
  - Policy: keep failure logging.

## Virtual Audio Playback

Added while debugging Emby/Ampcast/Narjo compatibility and virtual audio fallback paths.

- `src/lib/emby/local-handlers.ts`
  - Events include:
    - `external_emby_audio_proxy_failed`
    - `external_emby_audio_proxy_unusable`
    - `virtual_audio_metadata_missing`
    - `virtual_audio_playback_failed`
    - `virtual_audio_webdav_fallback_failed`
    - `virtual_audio_mapped_fallback_proxy_failed`
    - `virtual_audio_mapped_fallback_proxy_unusable`
    - `virtual_audio_quality_failed`
    - `virtual_audio_quality_skipped_unplayable_cache`
    - `virtual_audio_quality_retrying_stale_unplayable_cache`
  - Purpose: diagnose client-specific playback failures, stale unplayable cache, mapped-track fallback, WebDAV fallback, and quality fallback.
  - Policy: keep failed/unusable events; successful URL resolution and fallback logs have been removed.

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

## Remaining Optional Cleanup

- Consider removing worker per-job `claimed`/`completed` success lines only if production volume becomes excessive.
- Keep `scripts/cleanup-emby-duplicate-audio.ts` output as part of the CLI contract.
- Keep non-success HTTP request/response logs, with successful request logging opt-in only.

## Completed Hygiene

- QQ image cache failures log only a media URL summary (protocol, host, and path extension), not the complete image URL or query string.
- Removed QQ login progress and success-stage events; only `qq_login_failed` remains.
- Removed QQ authorization attempt, success, and applied events; failures and degraded states remain.
- Removed music URL candidate and successful-attempt events; failed attempts and final failures remain.
- Removed successful virtual audio URL resolution and WebDAV fallback events.
- Removed the recommendation normal-success logging override; only slow and timeout loads are logged.

## Review Checklist

- Confirm no log emits raw cookies, tokens, signed URLs, passwords, or full media URLs.
- Check production log volume after real-account QQ auth validation.
- Prefer keeping failed/anomalous events and removing success/attempt events.
- Keep environment-gated debug logs off by default.
