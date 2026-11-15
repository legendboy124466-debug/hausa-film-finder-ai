# HAUSA FILM FINDER AI

**Gano Fim ɗinka Cikin Sauƙi.**

The existing root HTML/CSS/JavaScript interface is served by an Express backend. SQLite is the persistent source of truth; the legacy root `movies.json` remains untouched and is imported once when the SQLite catalogue is empty.

## Requirements

- Node.js 22.5 or later (uses the built-in `node:sqlite` module).
- FFmpeg and FFprobe available on `PATH` (or configure `FFMPEG_PATH` and `FFPROBE_PATH`).
- Chromaprint's `fpcalc` executable available on `PATH` (or configure `FPCALC_PATH`) for genuine audio fingerprints.

Install Node dependencies with `npm.cmd install` in PowerShell. Install FFmpeg from [ffmpeg.org](https://ffmpeg.org/download.html) or a trusted operating-system package manager. Install Chromaprint/`fpcalc` from the official [Chromaprint project](https://github.com/acoustid/chromaprint). Restart the server after installing media tools. The app reports an unavailable tool as an error; it never substitutes file metadata or reports a fake match.

Set `ADMIN_USERNAME`, a private `ADMIN_PASSWORD` of at least 12 characters, and a random `SESSION_SECRET` of at least 32 characters in the root `.env`. The Admin Dashboard stays locked until these values are valid. The optional Mohammad AI chat uses a local Ollama runtime: install Ollama, download a model, then set `MOHAMMAD_AI_MODEL`; the default local address is `http://127.0.0.1:11434`. No OpenAI key is used by this implementation. The server loads the root `.env` before its backend modules start. Do not share or commit `.env`; restart the backend after changing it.

```powershell
npm.cmd start
```

Open the public site at `http://localhost:3000` and the Admin Dashboard at `http://localhost:3000/admin`. In PowerShell use the `.cmd` npm launcher shown above. Never publish `.env` or use example credentials on an internet-facing server. For public deployment, use HTTPS and a hardened reverse proxy.

## Fingerprints and long movies

The worker probes each authorized uploaded movie, divides the actual duration into four-minute intervals, and includes the shorter final interval. A single FFmpeg decode per segment writes sampled visual frames and bounded temporary audio chunks; the movie itself is never loaded into memory. Short final audio intervals use a minimum eight-second window ending at the real movie end, with their actual earlier timestamp retained. SQLite stores records keyed by movie, segment, modality, and timestamp. Completed segments are committed independently so interrupted work can resume without duplicating them.

Fingerprint jobs run one at a time by default for computers with limited RAM. Set `FINGERPRINT_MAX_CONCURRENT_JOBS=2` to allow two concurrent jobs; values are capped at two. FFmpeg extraction has a 15-minute segment timeout by default, configurable with `FINGERPRINT_FFMPEG_TIMEOUT_MS` (capped at 60 minutes).

Visual hashing is a genuine perceptual image fingerprint, not a filename/size comparison. Audio recognition requires `fpcalc`; image/video recognition requires FFmpeg. Results are returned only when their measured hash similarity meets the configured matching threshold. A match score is a computed similarity, not a claim that recognition has been validated for every media source.

Movie uploads, posters, SQLite data, and job status stay on the server. Posters are stored separately from source movies and fingerprint records. Use only material you own or are authorized to process. No DRM is bypassed.

## Merlin collection

The admin dashboard includes ten fixed Merlin episode slots. Upload episodes individually or in bulk using filenames containing their episode number (for example, `Merlin 01.mp4`). Each slot stores its title, description, video, and optional poster; metadata lives in SQLite and media files live under `uploads/merlin` by default. Set `MERLIN_UPLOAD_DIR` to use a different persistent media directory. Keep that directory outside Git and include it in server backups. The video endpoint supports browser byte-range playback for seeking. Browser playback depends on the codecs supported by the viewer's device; MP4/H.264 is the broadest compatibility choice.

The admin movie form accepts a video selected from the computer, title, optional poster, description, and optional season/episode numbers. Authorized movies appear in the public catalogue while fingerprint processing is pending. Select a movie card for its details and use **PLAY** to stream it with byte-range support; playback keeps audio enabled. Chrome playback is most reliable with MP4/H.264 video and AAC audio. The server checks the actual codecs and converts incompatible files into a separate MP4/H.264/AAC playback copy when needed; it never replaces the uploaded original. A job is marked completed only after every segment has non-empty visual fingerprints and, when the source has audio, non-empty audio fingerprints.

## Admin and assistant

Admin login is enabled only when `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `SESSION_SECRET` are configured. Session cookies are HTTP-only and signed; they use SameSite strict for the website and SameSite none with Secure for explicitly allowed Capacitor origins. Mohammad AI is optional and only connects to the configured private Ollama runtime.

`MOHAMMAD_AI_MODEL` selects the local model. Mohammad AI sends text only and replies in Hausa by default. If the runtime or model is missing, it reports that clearly and does not fall back to a paid provider. The homepage's optional welcome greeting is separate from Mohammad AI and is not an audio conversation feature. It can use a browser-installed Hausa (`ha`) speech voice or an authorized recording at `assets/hausa-welcome.mp3`.

The homepage promotional image is the supplied poster at `assets/hausa-film-finder-promotional-poster.png`. It is displayed as a separate image, retaining its original aspect ratio; it does not replace or alter the app interface.

## Android app

The Android wrapper packages only the existing HTML, JavaScript, CSS, app icons, and promotional image. The database, `.env`, movie uploads, posters, and videos remain on the backend and are never copied into the APK. No backend is deployed by the Android build.

Install Node.js, JDK 21, and Android Studio with its Android SDK, then install dependencies with `npm install`. Build a debug APK with:

```powershell
npm run android:build
```

The generated APK is `android/app/build/outputs/apk/debug/app-debug.apk`. Copy it to an Android phone, open it in Files/Downloads, allow installation from that source if Android asks, and tap **Install**. This is a debug build for direct installation, not a Play Store release.

On first launch, set the backend's public HTTPS URL in **Haɗin server** and use **Gwada haɗi**. `localhost` is intentionally rejected because it refers to the phone, not the Windows computer. The backend must be reachable over HTTPS; the app origin `https://localhost` is allowed for Capacitor CORS and its cross-origin session cookies. Add any additional HTTPS app origins as comma-separated entries in `CAPACITOR_APP_ORIGINS` in the backend `.env` before restarting the server. Keep admin credentials and API keys on the backend.

Cloud deployment templates and current deployment status are documented in [`deploy/README.md`](deploy/README.md). The templates do not deploy or expose the application.

## Database and backups

The SQLite database is created at `backend/data/hausa-film-finder.sqlite`. Back it up while the server is stopped (or use SQLite's online backup facilities). JSON files in `database/` are retained for import/compatibility; SQLite is authoritative once the server starts.

### Verified database and media backup

The backup command uses the SQLite shell's `.backup` command (SQLite Online Backup API), then copies the persistent movie uploads, Merlin videos, playback copies, posters, and social uploads. It writes a timestamped folder with a manifest and SHA-256 for the database and every copied media file. It does not include `.env`, secrets, temporary samples, or logs. It does not update `movie_path`.

For a consistent database and media snapshot, stop the server first. Install the SQLite command-line shell (`sqlite3.exe` on Windows) and make sure it is available on `PATH` or set `SQLITE3_PATH`. In PowerShell:

```powershell
# Stop npm start with Ctrl+C first. Choose an existing private destination,
# ideally on a separate disk.
$env:HF_BACKUP_QUIESCED = "YES"
npm.cmd run backup -- create --destination "D:\HF-Film-Backups"
```

The command reads the database path and media directories from the same environment variables as the server (and loads the root `.env` without printing its values). It refuses to run without the explicit stopped-app acknowledgement and never overwrites a timestamped backup.

To rehearse a restore, choose a new, empty destination outside the backup folder:

```powershell
npm.cmd run backup -- restore --source "D:\HF-Film-Backups\hausa-film-finder-TIMESTAMP" --target "D:\HF-Restore-Test"
```

Restore verifies every SHA-256, runs `PRAGMA integrity_check` and `PRAGMA foreign_key_check`, and writes only into that new folder. It does not replace the source database or move media. Review `manifest.json`; the restored database and media are under `database/` and `media/` and require deliberate path configuration before a real restore.

For Linux VPS scheduling and the service-stop wrapper, see `deploy/README.md` and the example systemd files. The destination must be a mounted device separate from the VPS disk. Backup output is append-only: this project does not automatically delete old backups. Keep the destination private and encrypted, and place an additional copy in a separate provider/account when one is configured.

## Tests and current limitations

Run `npm.cmd test` for unit and API tests; the tests generate temporary MP4 fixtures and require FFmpeg and Chromaprint on `PATH`. Recognition needs authorized sample media. Validate beginning/middle/end matching and interrupted-job recovery with authorized test media before relying on results for a full collection.
