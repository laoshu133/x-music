# Account, QQ Authorization, and Emby Redesign

## Goals

- Users register and sign in with an XMusic username and password.
- The first user created in an empty database is the administrator.
- Every user owns one independent QQ Music authorization shared by that user's sessions.
- A user must have an active QQ authorization before using music, player, or personal Emby features.
- Administrator permissions are additive: administrators remain normal users with their own QQ authorization.
- Existing beta accounts and user-owned data are intentionally reset instead of migrated.

## Identity Boundaries

`user_id` is the only ownership key. It scopes sessions, favorites, play history, remote mappings, user jobs, QQ authorization, and Emby configuration.

`qq_uin` is not an identity key. It may only appear inside the QQ protocol implementation and the user's QQ authorization record. API responses nest it under `qq`, and ordinary business APIs never accept a caller-supplied UIN.

The main records are:

- `users`: stable ID, canonical username, password hash, role, and account status.
- `user_sessions`: hashed opaque browser sessions with expiry and revocation.
- `qq_authorizations`: one encrypted QQ credential set per user; QQ UIN is globally unique.
- `user_emby_profiles`: per-user player secret and upstream Emby/WebDAV configuration.
- `player_tokens`: random, revocable Emby-compatible access tokens.

## Authorization Rules

- Public: registration bootstrap, sign-in, static resources, and protocol-required public server discovery.
- Signed in without QQ: account security, sign-out, and management of the current user's QQ authorization.
- Signed in with active QQ: music APIs, favorites, history, player, and personal Emby information.
- Administrator: user and job management regardless of the administrator's own QQ state.

QQ expiry never signs the user out. Web APIs return `QQ_AUTH_REQUIRED`; Emby business APIs reject access without invalidating the XMusic browser session.

## QQ Authorization

QR, mobile, and Cookie authorization require an existing XMusic session and update only that user. Authorization attempts are bound to `user_id`, session, version, and expiry so stale attempts cannot overwrite newer credentials.

Reauthorizing the same QQ only rotates credentials. Binding a different QQ is an explicit replacement operation that invalidates old QQ sync state. A QQ UIN already bound to another user is rejected.

## User-Owned and Shared Data

The following data is user-owned and always carries `user_id`:

- favorites and favorite synchronization state;
- play history;
- remote Emby mappings and synchronization events;
- QQ/Emby synchronization requests;
- personal Emby and WebDAV configuration.

Tracks, prepared media files, artwork, lyrics, and safe immutable resource cache entries remain shared.

Media download, decrypt, tagging, and cleanup jobs are global. QQ history, favorites, and Emby delivery jobs are user-scoped. When multiple users request the same globally prepared track, `user_track_sync_requests` retains every requesting user and produces one Emby sync job per user after media preparation.

## Emby Identity

The canonical XMusic username is also the local and upstream Emby username. Usernames are lowercase, immutable, case-insensitively unique, 3-32 characters, and match `[a-z0-9][a-z0-9._-]*`.

Emby UserId is derived from stable `user_id`, never QQ UIN or username. Player tokens are random and revocable. The player password is separate from the XMusic password and can be reset without changing the XMusic login.

Upstream users are located by a previously saved upstream user ID. An unbound upstream user with the same username is treated as a conflict rather than being adopted automatically.

## Beta Reset

A one-time schema version reset removes old accounts, QQ sessions, favorites, play history, remote mappings, sync events, jobs, and legacy account-level `emby.*` settings. Tracks, media files, resource cache, and non-account global settings remain. Old browser and player credentials become invalid.

The reset is versioned and transactional, and a timestamped SQLite backup is made before destructive changes. It never runs repeatedly after the schema version is recorded.

## Acceptance Criteria

- Two sessions for one user observe the same QQ authorization.
- Updating one user's QQ authorization cannot affect another user.
- No ownership query, API, job, cache mapping, or Emby identity depends on QQ UIN.
- Shared media preparation creates independent user delivery jobs.
- Emby username comes from the XMusic username and remains independent of QQ changes.
- Administrators without QQ authorization can manage users and jobs but cannot use personal music or Emby features.
- Source checks prevent new ownership uses of `qqUin` outside QQ authorization and protocol modules.
