# CloudSeed

Self-hosted cloud file manager with Google sign-in, quotas, a remote download engine, Telegram delivery, a media library with streaming, secure sharing, an admin area, notifications, and encrypted backups.

## Status

All six milestones are implemented, apart from the gaps listed below. **Only what is listed under "Implemented" exists**; anything not built is deliberately absent from the UI.

| Implemented | Not implemented |
|---|---|
| Google OIDC login (auth-code + PKCE, state, nonce, JWKS signature/issuer/audience, `email_verified`) | BitTorrent/magnet downloads |
| Server-side sessions, CSRF + Origin checks, rate limiting, RBAC roles, audit log | Sharing whole folders (only single files can be shared) |
| Folders and files: streamed upload, Range download, rename, move, delete, search, filter, sort, pagination, trash with retention | Two-factor authentication (sign-in is whatever Google enforces) |
| Per-user quota with atomic enforcement; max file size | Antivirus scanning of uploads and downloads |
| Local filesystem and S3-compatible storage, plus a verified local → S3 migration tool | Authenticated download sources (by design) |
| Remote HTTP/HTTPS downloads: Postgres-backed queue, separate worker, pause/resume/cancel/retry, priorities, Range resume, SHA-256 check, backoff, crash recovery, live progress, SSRF protection, per-user limits | Telegram *notifications* (Telegram is used to deliver files, not to notify) |
| Telegram via the official Bot API: encrypted bot tokens, real permission checks, albums, captions, oversize files as numbered parts **or** as an expiring download link, flood-limit pacing, no-duplicate rule for unknown deliveries, history | Media: scrub-preview thumbnails, adaptive/live streaming, image-based subtitles |
| Media library: FFmpeg indexing, thumbnails, subtitles, Range streaming, resume, optional conversion to MP4/AAC | Redis (deliberately not used: the queue lives in PostgreSQL) |
| **Sharing**: hash-only tokens, always-expiring links, optional password, download limits, public or sign-in-only, revoke, abuse reports | Per-link access logs beyond counts and last access |
| **Notifications**: in-app bell, per-kind muting, optional email over SMTP with retry and a per-user hourly cap, quota and expiring-link warnings | Push / SMS notifications |
| **Account**: settings, active sessions with revoke, JSON data export, account deletion | |
| **Administration**: users (disable, roles, quota), abuse review, queue and worker health, audit log, runtime settings, `/health/ready`, Prometheus `/metrics` | |
| **Backups**: encrypted, snapshot-consistent backup / verify / restore, reconcile, storage migration (command line) | Scheduled backups (use cron or your scheduler; see below) |

## Quick start (Docker)

```bash
cp .env.example .env
# edit .env: set POSTGRES_PASSWORD, SESSION_SECRET, GOOGLE_* and ADMIN_EMAILS
docker compose up --build -d
```

Open http://localhost:8080. The `migrate` service applies migrations before the API starts. Check with `docker compose ps` and `docker compose logs api`.

Without Google credentials the app runs but the login page shows a clear "not configured" state.

## Google sign-in setup

1. Google Cloud Console → create/select a project → **APIs & Services → OAuth consent screen**. Choose *External* (or *Internal* for Workspace), fill in app name and support email. Scopes: only `openid`, `email`, `profile` (CloudSeed requests nothing else; no Drive or Gmail access).
2. **Credentials → Create credentials → OAuth client ID → Web application**.
3. **Authorized JavaScript origins:** your `PUBLIC_URL` (e.g. `http://localhost:8080`).
4. **Authorized redirect URIs:** exactly `GOOGLE_REDIRECT_URI`, i.e. `<PUBLIC_URL>/api/v1/auth/google/callback`.
5. Put the client ID/secret in `.env`. The secret is only ever read by the API.
6. While the consent screen is in *Testing*, add your Google accounts as test users.
7. **Production requires HTTPS.** Google only allows plain `http` for `localhost`, and the API refuses to start in production with an `http://` `PUBLIC_URL`.

`ADMIN_EMAILS` lists emails that become administrators on their first verified sign-in. `REGISTRATION_POLICY=closed` lets only those emails register. A Google identity is keyed on its `sub`; a new identity is **never** auto-linked to an existing account by email.

## Storage

**Local (default):** files live in the `storage` Docker volume (`/data`). Uploads are written to a temp file and renamed into place.

**S3-compatible:** set `STORAGE_BACKEND=s3` plus `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and for non-AWS providers `S3_ENDPOINT` (and `S3_FORCE_PATH_STYLE=true` where required, e.g. MinIO). For DigitalOcean Spaces use `S3_ENDPOINT=https://<region>.digitaloceanspaces.com` and `S3_REGION=<region>`.

- Keep the bucket **private**. CloudSeed never makes objects public; all downloads are authorised by the API and streamed through it.
- Uploads stream as multipart with bounded memory, and an object only appears once the upload completes.
- Use an access key restricted to the one bucket (`GetObject`, `PutObject`, `DeleteObject`, `ListBucket`, multipart permissions).
- The dashboard shows **quota** and **application-accounted usage**. S3 APIs do not expose bucket capacity, so none is shown for S3.
- Switching `STORAGE_BACKEND` only affects *new* uploads. Existing files stay on the backend that holds them and remain readable while that backend is configured. There is no automated migration yet, so do not remove the old backend's data or configuration until every file has been moved by other means.

**Trash:** deleting moves items to the Trash. They keep counting toward quota until deleted permanently (manually, or automatically after `TRASH_RETENTION_DAYS`, default 30; `0` disables automatic purging). Restoring a file whose name has since been reused renames it (`name (1).ext`).

## Downloads

Paste a link on the **Downloads** page (or `POST /api/v1/downloads`). **Check link** previews the filename, size and whether the server supports resuming, and warns if the file exceeds your size limit or free space. A **worker** process (separate container) fetches the file into a workspace directory and, only when complete and verified, moves it into your storage; quota is charged atomically at that moment.

- **States:** `queued` → `resolving` → `downloading` → `verifying` → `completed`, plus `pending` (waiting out a retry delay), `paused`, `failed`, `cancelled`.
- **Controls:** pause, resume, cancel, retry, change priority, remove finished records. Pause/cancel of a running job is picked up by its worker within about a second.
- **Resuming** uses `Range` with `If-Range`, and only when the server supplied a strong `ETag` or a `Last-Modified`. If the server ignores Range, rejects it, or the remote file changed, the download restarts cleanly from byte 0; it never splices old and new content. Without a validator it also restarts. The preview tells you which case applies.
- **Retries:** network errors, timeouts, HTTP 408/425/429/5xx are retried with exponential backoff and jitter (`Retry-After` is honoured), up to `DOWNLOAD_MAX_ATTEMPTS`. HTTP 4xx, blocked destinations, size/quota problems and checksum mismatches fail immediately. A stalled connection is detected by a watchdog that ignores time spent paused by our own backpressure.
- **Integrity:** supply a SHA-256 under *Verify checksum*; a mismatch fails the job and stores nothing.
- **Crash recovery:** a worker renews a short lease while it works. If it dies (OOM, `SIGKILL`, host reboot) another worker takes the job after the lease expires and continues from the partial file. A job that keeps killing workers is eventually failed, not retried forever. On `SIGTERM` a worker puts its jobs back in the queue with their progress kept.
- **Why PostgreSQL, not Redis, for the queue:** jobs must survive restarts and be recoverable and inspectable; the database already provides that (`FOR UPDATE SKIP LOCKED`, leases), the API and workers then share one source of truth for progress, and there is one less service to run and back up. Live updates reach the browser over Server-Sent Events, polled from the database once a second per open stream.
- **Scaling:** `docker compose up -d --scale worker=2`. `DOWNLOAD_GLOBAL_CONCURRENCY` and `DOWNLOAD_USER_CONCURRENCY` are enforced across all workers.

### SSRF policy

Users submit URLs that the server then fetches, so by default only public destinations are reachable. Blocked: non-http(s) schemes, URLs with credentials, ports other than `DOWNLOAD_ALLOWED_PORTS`, and every loopback, private (RFC 1918), CGNAT, link-local (incl. `169.254.169.254`), multicast, NAT64/6to4/Teredo and IPv6 unique-local/link-local address. A hostname is resolved once and the *validated address is the one connected to*, so DNS rebinding cannot swap it afterwards; a name with any blocked address is refused; each redirect hop is re-checked. If you really need to fetch from an internal host, list its network in `DOWNLOAD_ALLOWED_CIDRS`. Do this only for networks you trust every user to reach.

Not supported by design: scraping pages, DRM circumvention, or sources needing credentials. Torrents/magnets are planned as a separate optional module and are not implemented.

### Tuning for a small VPS (1–2 GB RAM)

`DOWNLOAD_GLOBAL_CONCURRENCY=2`, `DOWNLOAD_USER_CONCURRENCY=1`, `WORKER_CONCURRENCY=2`, `DB_POOL_MAX=5`, and set `DOWNLOAD_BANDWIDTH_LIMIT_BPS` if downloads starve other traffic. Disk is the real limit: partial files live in the `downloads` volume and a finished file is briefly present in both the workspace and storage. Keep free space of at least your largest allowed file (`MAX_FILE_SIZE_BYTES`) times the global concurrency.

## Telegram

CloudSeed sends files to Telegram groups, supergroups and channels through a **bot you own**, using the official Bot API. It never asks for your Telegram password and does not use a personal-account session.

### Setup

1. **Create a bot:** in Telegram open [@BotFather](https://t.me/BotFather), send `/newbot`, pick a name and a username ending in `bot`. Copy the token it gives you.
2. **Connect it:** *Telegram → Bots → Connect bot* and paste the token. CloudSeed checks it with Telegram, then stores it encrypted (AES-256-GCM, bound to your account). It is never shown again, never returned by the API, and never logged. You can test the connection, **rotate** the token (it must be the same bot) or **disconnect** (token erased, queued files cancelled, history kept).
3. **Add the bot to the chat:**
   - *Group / supergroup:* add the bot as a member. If the group restricts members, allow messages and files, or make the bot an admin.
   - *Channel:* add the bot as an **administrator with "Post messages"**. A plain member cannot post to a channel.
4. **Register the destination:** *Telegram → Destinations*. Give a numeric chat ID (`-100…` for supergroups and channels; a bot such as `@getidsbot` can tell you), an `@username` or a `t.me/…` link. CloudSeed asks Telegram for the bot's actual membership and permissions and shows exactly what is missing. *Send test message* proves it end to end; *Recheck permissions* re-validates after you change something in Telegram.

### Sending

Select files in **My Files** and choose **Send to Telegram**. You review each file, how it will be sent and its size before confirming, and can add a caption (up to 1024 characters; it goes on the first message only).

- **Best fit** sends JPEG/PNG as photos (Telegram recompresses photos), MP4 as video, MP3/M4A as audio and everything else as a document. **Files** always sends documents and preserves the original bytes. If Telegram rejects a photo, video or audio (dimensions, codec), that file is automatically re-sent as a document.
- **Albums** group compatible items into `sendMediaGroup` albums of 2–10: photos and videos may mix, audio only with audio, documents only with documents.
- Filenames are preserved. Per-file upload progress, message IDs and message links are recorded. Public chats get a public link; private supergroups and channels get a members-only link; basic groups have none because Telegram offers none.
- Indexed videos and audio files (see the media library) are sent with their thumbnail (JPEG, under 200 kB and 320 px) and their dimensions, duration, title and artist. If Telegram rejects the thumbnail, the file is sent again without it (it was rejected before anything was posted, so nothing can be duplicated). Albums, parts and plain-document sends carry no thumbnail.

### Size limits (two different deployment modes)

| Mode | Setting | Per-file upload limit |
|---|---|---|
| Official hosted Bot API | `TELEGRAM_API_MODE=hosted` (default) | **50 MB** (photos 10 MB) |
| Your own `telegram-bot-api` server | `TELEGRAM_API_MODE=self-hosted` | **2000 MB** |

Both figures come from Telegram's official documentation (the Bot FAQ and Bot API pages), checked while building this. They can change, which is why they are settings rather than constants: override with `TELEGRAM_MAX_UPLOAD_BYTES` if Telegram changes them or your server is configured differently. Telegram remains the final authority: if it answers "too large", the file fails with that reason instead of being retried.

A file over the limit is **never truncated and never half-sent without saying so**. You get a clear message and, if you choose it, the file is sent as numbered parts `name.001`, `name.002`, … read straight from storage with no temporary copies. Rejoin them with `cat name.0* > name` (Linux/macOS) or `copy /b name.001+name.002+… name` (Windows). An expiring share link is *not* offered yet because sharing links are not implemented; the dialog says so instead of pretending.

**Self-hosted Bot API server** (optional, off by default): get an API ID and hash at <https://my.telegram.org>, put `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` in `.env`, set `TELEGRAM_API_MODE=self-hosted` and `TELEGRAM_API_BASE=http://telegram-api:8081`, then run `docker compose --profile telegram-local up -d`. This profile has **not been run** (there is no Docker on the development machine) and its image name and environment variables are from memory of the aiogram/telegram-bot-api documentation, so check them and pin an image tag before relying on it.

### Reliability: what happens when something goes wrong

- **Rate limits:** sends into one chat are spaced (`TELEGRAM_CHAT_INTERVAL_MS`, default 3 s, matching Telegram's roughly 20 messages per minute per group). A Telegram 429 is obeyed (`retry_after`) without using up retry attempts.
- **Connection problems before the file was sent** are retried with exponential backoff and jitter, up to `TELEGRAM_MAX_ATTEMPTS`.
- **Unknown outcomes are never retried automatically.** Telegram has no idempotency keys, so if the whole file was sent and then the connection dropped, Telegram answered 5xx, no answer arrived, or the worker crashed mid-delivery, the message may or may not exist. That file is marked *delivery unknown* and **waits for you**: check the chat, then retry with explicit confirmation ("this may create a duplicate"). A graceful shutdown aborts uploads still being written (safe to requeue) and waits for those already fully sent.
- **Permission and chat errors** (`no_permission`, `chat_not_found`, …) are permanent, explained, and mark the destination unusable until you re-validate it.
- **Revoked token (401):** the bot is flagged, you are notified, and queued files are kept and resume after you rotate the token.
- A group upgraded to a supergroup (`migrate_to_chat_id`) is followed automatically.
- A file deleted before it is sent fails with `source_missing`. *Retry failed files* resends only what failed; *Send again* creates a new transfer. Only files still waiting can be cancelled; an upload already in flight cannot be recalled.

### Security

Bot tokens are encrypted with `ENCRYPTION_KEY` (required in production; generate with `openssl rand -base64 32`) using a fresh IV per record and the owner's ID as authenticated data, so ciphertext copied to another account does not decrypt. **Back the key up together with the database**: without it, stored tokens are unreadable and bots must be reconnected. Re-keying (changing `ENCRYPTION_KEY`) is not automated. Each user's bots, destinations and transfers are isolated: every query is scoped by user and foreign IDs return 404. The Bot API address is server configuration, not user input, so users cannot make the server contact arbitrary hosts.

## Media library

Audio and video files (by extension: mp4, m4v, mov, webm, mkv, avi, ogv, mp3, m4a, aac, flac, wav, ogg, oga, opus) are indexed automatically in the background, whether they were uploaded or downloaded. Open **Media Library**:

- **Index:** the worker runs `ffprobe` for duration, dimensions, container, codecs, bitrate, audio/subtitle tracks and tags (title, artist, album), creates a JPEG thumbnail (a frame about 10 % in, or the embedded cover art of an audio file), and extracts embedded *text* subtitle tracks to WebVTT. You can play a file before indexing finishes. Unreadable files are marked "Unreadable" with a *Try again* button; they are not retried in a loop.
- **Library:** search (title, filename, artist, album), filter by type, date range and progress, sort by date/title/duration/size, pagination, and a **Continue watching** view.
- **Player:** resumes where you stopped (saved every 5 s, on pause and when the tab is hidden), speed 0.5–2×, subtitles, picture-in-picture, full screen, and keyboard shortcuts (press `?`): Space/K play, ←/→ ±5 s, J/L ±10 s, ↑/↓ volume, M mute, F full screen, C subtitles, `<`/`>` speed, P picture-in-picture, 0–9 jump, Home/End.
- **Subtitles:** embedded text tracks, plus external `.srt`/`.vtt` files in the same folder named like the video (`Movie.srt`, `Movie.en.srt`, `Movie.English.vtt`), plus any subtitle file you link explicitly. SRT is converted to WebVTT on the fly; legacy encodings are decoded. Image-based subtitles (PGS, VobSub) cannot be shown in a browser and are listed as unavailable.
- **Audio tracks:** listed, but switching only works in browsers that expose `audioTracks` (mainly Safari); elsewhere the control is disabled and says why.
- **Streaming:** straight from storage with HTTP Range (seeking works, nothing is buffered or copied), authorised on every request, never a public URL. Files are served `inline` but sandboxed (`CSP: sandbox`, `nosniff`), and the file's **extension decides its type**, so a renamed file cannot be served as something else.
- **Compatibility:** from the probe CloudSeed tells you when a browser is unlikely to play a file (HEVC, AVI, unusual audio codecs: "would play without sound"), or may not (MKV, Ogg), and what to do. That is a heuristic, not a guarantee; if the browser still fails you get the same help.

### Converted copies (transcoding, optional)

Off by default (`MEDIA_TRANSCODING_ENABLED=true` to enable) because it is CPU heavy. From the player you can create a browser-friendly copy: `web-720p` / `web-480p` (H.264 + AAC MP4, `+faststart`) for video or `audio-aac` for audio. It runs in the worker with progress, a timeout and a size cap, and the result is selectable under *Version*; when the original is unplayable the converted copy is chosen automatically. This is a one-time conversion, not live/adaptive streaming (no HLS/DASH).

### Derived files

Thumbnails, extracted subtitles and converted copies are stored in your storage backend, **count toward your quota**, and are removed (and the quota released) when the source file is deleted for good.

### FFmpeg and security

FFmpeg is installed in the Docker image (`apk add ffmpeg`). Outside Docker, install it or set `FFMPEG_PATH` / `FFPROBE_PATH`. Only the **worker** runs FFmpeg; the API never does. Every file is treated as hostile:

- The demuxer is **forced from the validated extension** (`-f mov`, `-f matroska`, …) and protocols are whitelisted (`file` only, or `http,https,tcp,tls,crypto` for S3). This was verified: with FFmpeg's default format sniffing, an "`.mp4`" that is really an HLS playlist is detected as HLS and makes FFmpeg try to open the local file it names; with the forced demuxer it is rejected as invalid and nothing is read. The test suite keeps that file as a regression test. Playlist/concat/script extensions (`.m3u8`, `.sdp`, …) are never handed to FFmpeg at all.
- Run without a shell, minimal environment (no secrets inherited), hard timeouts, capped output, bounded attempts, and lease-based recovery. For S3 the input is a short-lived presigned URL that stays inside the worker process and is never stored, logged or returned.
- FFmpeg itself is a large parser of untrusted formats; keep it up to date, and give the worker container CPU/memory limits (see `compose.prod.yaml`).

### Not built

Scrubbing preview thumbnails, adaptive streaming, live transcoding, image-based subtitles, selecting audio tracks in most browsers, and per-user transcoding quotas beyond the storage quota.

### Checked in a real browser (Milestone 6 screens)

The notification bell (unread badge, mark all read), Settings, every Administration tab, the share dialog, creating a link and opening it as an anonymous visitor (download, then the "download limit reached" page), dark mode and a 390 px phone layout (no horizontal overflow) were driven in headless Chromium against `npm run ui-stack`, with no console errors. Again by hand, not in CI. The Admin actions that change data (disable user, resolve report) and the account-deletion dialog are covered by API tests but were not clicked through in a browser.

### Checked in a real browser

During development the UI was driven in headless Chromium against a real stack (`npm run build && npm run ui-stack`, which starts a disposable PostgreSQL, the built API and worker, a fake Telegram Bot API and seeded media with a ready-made session, **development use only**). Verified there: the library and thumbnails, playback of a WebM, every keyboard shortcut, subtitles, speed, resume after reload, "continue watching", the unplayable-AVI message, conversion and playing the converted copy, the full Telegram flow (connect bot, add destination, test message, send two files with a caption, history with message links), a phone-width layout with no horizontal overflow, and dark mode. That was done by hand, **not an automated test**: it is not in CI, and Safari and Firefox were never tried.

## Sharing

Any file you own can be shared from **My Files** (the share icon). Links are for single files.

- **Always expire.** You pick a lifetime from 1 hour up to `SHARING_MAX_DAYS` (default 365). There is no permanent link.
- **The token is shown once.** Only its SHA-256 is stored, so neither the database, a backup nor an administrator can recover a link. Lose it and you create a new one.
- **Public or sign-in only.** A public link works for anyone who has it, and creating one requires ticking an acknowledgement. A *signed-in users* link needs a CloudSeed login.
- **Optional password** (8+ characters, scrypt-hashed), with per-address and per-link attempt limits. A correct password sets a 10-minute cookie scoped to that one link.
- **Optional download limit.** Counting is atomic, so two simultaneous downloads cannot both take the last one. Only a download that starts at byte 0 counts; resuming an interrupted one is free for 30 minutes after the limit is reached.
- **Revoke any time**, extend an expired link, and the owner can switch sharing off for a file entirely.
- **Safe delivery.** Files are always sent as attachments with `nosniff`; HTML, SVG and XML are sent as `application/octet-stream` so they cannot run in your origin; pages carry `noindex` and `Referrer-Policy: no-referrer`. Storage URLs are never exposed.
- **Abuse reports.** Anyone with a link can report it. Administrators review reports and can disable the link, or block sharing of that file. The owner is notified, and the reporter's address is stored only as a one-way hash.
- A link to a file in the trash or a deleted file stops working at once.

Telegram offers the same links as an alternative when a file is too large to upload: the message says plainly that the file is **hosted by CloudSeed, not stored on Telegram**, and that anyone in that chat who can read it can use the link.

## Notifications and email

The bell in the header shows in-app notifications (download finished or failed, Telegram transfer result, storage nearly full, a link about to expire, a link disabled by an administrator, the bot disconnected). Each kind can be muted in **Settings**.

Email is **optional and off until you configure SMTP**:

```
SMTP_HOST=smtp.example.com
SMTP_PORT=587          # 465 with SMTP_SECURE=true
SMTP_USER=...  SMTP_PASS=...  SMTP_FROM="CloudSeed <noreply@example.com>"
```

Users then opt in under Settings → Notifications. A worker process emails each notification at most once, retries failures with growing delays and gives up after three attempts (the in-app notification is unaffected), and sends no more than `EMAIL_MAX_PER_HOUR` (20) per user. The connection must be encrypted (`SMTP_REQUIRE_TLS=true`) so credentials never cross the network in clear text. Log lines about failed emails contain an error code only, never addresses or content. Without SMTP the toggle is disabled and says why.

The same worker raises a *storage almost full* warning at `QUOTA_WARNING_PERCENT` (90 %, at most once a day), warns a day before a share link expires, removes notifications older than `NOTIFICATION_RETENTION_DAYS` (90) and clears expired sessions.

> **Tested against a local SMTP test server only**, using an unencrypted connection (`SMTP_REQUIRE_TLS=false` in the tests). STARTTLS / implicit TLS and delivery through a real provider have not been exercised. Send yourself a test notification after configuring it.

## Account settings

**Settings** lets each user choose a theme, a default folder for new downloads, personal download limits (simultaneous downloads and speed, which can only be *lower* than the server's), email notifications, which notification kinds to receive, and sign out other sessions (each session lists its device and last activity). **Export my data** downloads a JSON file of everything the account holds (no secrets, no storage paths; the files themselves come from My Files). **Delete account** needs the account email typed in, removes the account with all its files, links, downloads and Telegram connections, and then deletes the stored objects. The only administrator cannot delete themselves.

## Administration

Users with an address in `ADMIN_EMAILS` (or promoted by another administrator) get an **Administration** page:

- **Overview**: users, storage, live workers, active links, open reports, which optional features are on.
- **Users**: search; disable (signs them out immediately) or re-enable; grant or remove administrator; change a quota. An administrator cannot lock themselves out and the last administrator cannot be removed.
- **Reports**: abuse reports with the owner and history; dismiss, disable the link, or disable the link and block sharing of the file.
- **Operations**: worker heartbeats and queue depth for downloads, Telegram and media (including jobs whose lease expired). **Administrators see states and error codes, never users' URLs or file names.**
- **Audit log**: sign-ins, registrations, sharing and every administrator action, paged and filterable.
- **Settings**: open/closed registration and the default quota for new accounts (stored in the database and effective immediately). Everything else, including secrets, stays in environment variables.

### Health and metrics

- `GET /api/v1/health` and `/api/v1/health/ready` (database reachable; also reports how many workers were heard from in the last minute).
- `GET /api/v1/metrics` returns Prometheus text (request durations by route pattern, users, files, storage, share links, open reports, queue states, live workers). It is **off** until you set `METRICS_TOKEN` (16+ characters) and then needs `Authorization: Bearer <token>`. The bundled nginx answers 404 for it; scrape the API directly inside the Docker network (`api:8080`). No metric carries a user, file name or address.

## Backup, restore and maintenance

State lives in PostgreSQL and in the storage backend (local volume or S3 bucket). The `cli` tool backs up both **consistently**, as one encrypted file:

```bash
export BACKUP_PASSPHRASE='a long passphrase of 12+ characters'   # never an argument; or BACKUP_PASSPHRASE_FILE=/path
docker compose --profile tools run --rm -e BACKUP_PASSPHRASE cli backup --out /backups/cloudseed-$(date +%F).csbk
docker compose --profile tools run --rm cli verify /backups/cloudseed-2025-01-01.csbk
```

(Without Docker: `npm run build -w backend` then `node backend/dist/cli.js backup --out ...`.)

- **Consistent.** The database is read in a single `REPEATABLE READ` transaction, so every table reflects one instant even while the app runs. Objects created afterwards are not referenced by it; objects deleted meanwhile are reported as missing instead of silently skipped.
- **Encrypted and tamper-evident.** AES-256-GCM in 1 MiB frames with the key derived from your passphrase (scrypt, fresh salt per file). Wrong passphrase, flipped bits, dropped, reordered or appended frames and truncated files are all detected; nothing readable (names, emails, table names) appears in the file.
- **Honest.** The summary lists objects that were missing from storage or no longer matched their recorded SHA-256 when the backup was made; `--strict` turns those into a failing exit code. `--no-objects` backs up the database only and says so.
- **What it does *not* contain:** `ENCRYPTION_KEY` and `SESSION_SECRET`. **Keep `ENCRYPTION_KEY` safe, separately.** Without it, saved Telegram bot tokens cannot be decrypted after a restore (users reconnect their bots).
- **Restore** goes into a *fresh, migrated, empty* database of the *same schema version* and is atomic: the archive is verified first, then rows and objects are loaded in one transaction and everything (objects included) is rolled back on any failure. It refuses a non-empty target or a different version. Sequences are reset afterwards.

```bash
docker compose up -d postgres
docker compose --profile tools run --rm -e BACKUP_PASSPHRASE cli restore /backups/cloudseed-2025-01-01.csbk --yes
docker compose up -d        # with the SAME .env (ENCRYPTION_KEY!)
docker compose --profile tools run --rm cli reconcile
```

Schedule it with cron / systemd timers (`0 3 * * * ... backup ...`) and **copy the files off the machine**; a backup on the same disk is not a backup. Practise a restore before you need one.

**`cli reconcile`** compares the database with storage and exits 1 if anything is off: rows whose object is missing (restore them from a backup), size mismatches, orphan objects (deleted only with `--delete-orphans`, and never objects younger than `--grace-hours`, 24 by default, because an upload may be between "stored" and "recorded") and quota totals that disagree with the files (`--fix-quotas`). Running it nightly is cheap insurance.

**`cli migrate-storage --from local --to s3`** moves objects one at a time: copy, verify size and SHA-256, switch the row, and only with `--delete-originals` remove the source. It can be interrupted and re-run, `--dry-run` shows what would move, and files stay downloadable throughout. Set `STORAGE_BACKEND=s3` and the `S3_*` variables in the environment of the command, run it, then restart the server with the same settings.

> **Verified here:** the backup, verify, restore, reconcile and migrate-storage code is covered by automated tests against PGlite and an in-process S3 emulator (and the full suite against real PostgreSQL). **Not verified:** the Docker `cli` service and the exact commands above have never been run (no Docker on the development machine), the tools have not been tried on a large dataset, and restoring a backup into a different PostgreSQL major version was not tested.
>
> `pg_dump -Fc` plus a copy of the storage volume remains a valid alternative for operators who prefer standard tools. It is not consistent unless the app is stopped, it was not tested here, and it will contain the encrypted bot tokens (see `ENCRYPTION_KEY` above).

## Production

```bash
docker compose -f compose.yaml -f compose.prod.yaml up --build -d
```

- The API validates its configuration on boot and fails with a list of problems (short `SESSION_SECRET`, missing Google credentials, non-https URL, default DB password).
- The frontend binds to `127.0.0.1`; put a TLS reverse proxy (Caddy/Traefik/nginx) in front and forward `X-Forwarded-Proto`.
- Containers run as non-root, read-only, with capabilities dropped.
- Pin image tags/digests before deploying (`postgres:17-alpine`, `node:24-alpine`, `nginx-unprivileged:1.27-alpine` are version-tagged, not digest-pinned).

## Upgrading

```bash
git pull
docker compose -f compose.yaml -f compose.prod.yaml build
docker compose -f compose.yaml -f compose.prod.yaml up -d   # migrate runs first
```

Migrations are append-only. An applied migration that is edited afterwards is detected by checksum and aborts the run. **Take and verify a backup first** (see above). A backup restores only into the same schema version, so restore with the version that made it and then upgrade.

## Development without Docker

Requires Node 24 and PostgreSQL 15+.

```bash
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/cloudseed
npm run dev:backend            # applies migrations automatically in development
npm -w frontend run dev        # http://localhost:5173, proxies /api to :8080
```

## Tests

```bash
npm run typecheck
npm test                       # backend: 498 tests on in-process PGlite (+ in-process S3, local origin server, fake Telegram Bot API, real FFmpeg)
npm run test:pg -w backend     # the same 498 tests against a throwaway REAL PostgreSQL server
npm run build && npm run smoke # end-to-end: built API + worker + CLI processes, real PostgreSQL (53 checks)
TEST_WORKERS=1 npm test        # run test files strictly one at a time on a machine with little free memory
npm -w frontend run build
```

The backend tests run against **PGlite** (an in-process real PostgreSQL build), a fake Google IdP served over real HTTP with real RS256 keys, a **fake Telegram Bot API** that really parses the multipart uploads (so byte-for-byte delivery, album rules and permissions are checked), and **s3rver** (an in-process S3 emulator reached over HTTP, including multipart uploads). s3rver does not verify request signatures, so rejection of bad S3 credentials is not tested.

**Real PostgreSQL, no Docker needed.** `npm run test:pg -w backend` and `npm run smoke` start a throwaway PostgreSQL server from the binaries bundled by the `embedded-postgres` dev dependency (launched with `pg_ctl`, which also works under a Windows administrator account where `postgres.exe` refuses to run). Each test environment gets its own database. This found a real shutdown race that the faster-to-start in-process PGlite had masked.

**`npm run smoke`** runs the *built* API and worker as separate OS processes against real PostgreSQL. It downloads through the real API, pauses/resumes, streams SSE, and `SIGKILL`s a worker mid-download to prove a new worker recovers the file byte-for-byte.

The media tests generate real audio/video with FFmpeg at test time (the `@ffmpeg-installer/ffmpeg` and `@ffprobe-installer/ffprobe` dev dependencies supply binaries, an old 2018 FFmpeg build and a 2023 ffprobe; production uses the system FFmpeg, so codec behaviour in production may differ from what the tests saw).

**Test environment notes.** The suite starts many database servers and FFmpeg processes, so it wants a few GB of free memory. If a run dies with `Fatal process out of memory` or `Channel closed`, free memory and use `TEST_WORKERS=1` (or a small number). The throwaway PostgreSQL servers record their owner and the next run stops and deletes servers left behind by a crashed run; before that fix, leaked servers accumulated, ate the memory and made later runs fail more and more. On the development machine (about 1.5 to 2 GB free) the real-PostgreSQL run still lost a worker without any failing test in roughly one run in four; the cause of that was not found, and re-running passed. One timing-based download test (`does not resume without a validator`) also failed once in a full real-PostgreSQL run and passed 3 of 3 when re-run on its own; it was not investigated further.

One test (the backup *snapshot consistency* check) needs a second database connection while the backup transaction is open, so it is skipped on PGlite (single connection) and runs only under `npm run test:pg`.

Still not covered: Docker/Compose itself (the CI job that builds the images, validates the compose files and scans the images with Trivy has never run, and its action versions were written from memory), the real Telegram servers (only a faithful fake: nothing has been sent to real Telegram), the browser UI (no browser end-to-end tests yet), and Google's real servers (the OIDC flow is tested against a fake IdP with real signatures).

## Security notes

- Session tokens are random 256-bit values; only their SHA-256 is stored. Cookies are `HttpOnly`, `SameSite=Lax`, `Secure` (and `__Host-` prefixed) in production.
- State-changing requests need `X-CSRF-Token` and, if present, a same-origin `Origin`.
- Every file/folder query is scoped by `user_id`; foreign IDs return 404 (covered by IDOR tests).
- Downloads are always `Content-Disposition: attachment` with `nosniff` and a sandboxing CSP. File type is derived from the extension, not client input.
- Trashed items are invisible to listing, search, download and edit, and only the owner can restore or purge them.
- Uploads stream to a temp file and are renamed into place; failed or oversized uploads leave nothing behind.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Google sign-in is not configured` | `GOOGLE_*` unset; restart the API after editing `.env`. |
| `redirect_uri_mismatch` from Google | `GOOGLE_REDIRECT_URI` differs from the console entry (scheme, host, port, path). |
| `?auth_error=email_in_use` | That email already belongs to an account with a different Google identity; by design it is not linked. |
| API exits with `Insecure production configuration` | Fix the listed `.env` values. |
| 403 on every POST | Missing `X-CSRF-Token`, or the browser `Origin` differs from `PUBLIC_URL`. |
