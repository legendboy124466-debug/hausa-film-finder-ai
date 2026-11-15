# Cloud deployment preparation

This is a deployment template only. It has not been deployed and does not publish a port to the internet.

## Architecture

- One Linux VM/container host, initially about 4 vCPU and 8 GiB RAM.
- One Node 22 application instance. SQLite, the in-process fingerprint queue, and the existing resume-on-start worker require a single application instance.
- An encrypted, persistent block volume for `/var/lib/hausa-film-finder/database` and another for `/var/lib/hausa-film-finder/media`. Do not put SQLite on NFS or another network filesystem.
- Temporary FFmpeg/sample work uses `/tmp/hf-processing` (a 1 GiB tmpfs) and is not persistent.
- FFmpeg, FFprobe, and fpcalc are installed in the image. The queue concurrency remains one for the initial 8 GiB machine.
- The app has no host-published port. Caddy is an optional Compose `public` profile, with ports 80/443 and TLS certificates on persistent volumes. It proxies through a private Docker network to the app. Its example config allows the app's 30 GiB upload limit. Do not enable this profile until a domain, firewall, and HTTPS setup are intentionally approved.
- The website is served by this same backend. Android's existing **Haɗin server** setting points to that same HTTPS origin. No cloud URL is embedded in the APK.

SQLite and the uploaded media remain on persistent storage across replacement of the app container. Keep one app instance and keep the database on the same VM/block device. Move to PostgreSQL and object storage only when a planned migration and application support for those services are ready.

## Private Admin secrets

Create `deploy/cloud.env` from `deploy/cloud.env.example` on the cloud host and fill it using a private secret manager or terminal. It is Git-ignored. Compose passes these three values to the container as file-mounted secrets; the application reads `ADMIN_USERNAME_FILE`, `ADMIN_PASSWORD_FILE`, and `SESSION_SECRET_FILE`. Use a unique Admin password of at least 12 characters and a random session secret of at least 32 characters. Do not place real values in this repository, Dockerfile, image, or chat.

## Consistent database and media backups

`scripts/backup.js` creates an append-only, timestamped backup folder. It uses the SQLite shell's `.backup` operation against a read-only source connection, stores a logical SQLite snapshot (so an active WAL is handled by SQLite), copies persistent media, writes a manifest, and calculates SHA-256 for the database and each media file. Media includes movie originals, adjacent `.chrome.mp4` playback copies, Merlin episode files, posters, and social uploads. Nested movie directories are included once. Sample uploads and all secrets are excluded. Neither backup nor restore edits database rows or `movie_path`.

Database and media can change together during uploads or movie deletion. For that reason the command requires the app to be stopped for the whole copy. On a development computer, stop the server, install the SQLite CLI, set `HF_BACKUP_QUIESCED=YES`, and run `node scripts/backup.js create --destination <existing-private-folder>`. Set `SQLITE3_PATH` if the SQLite executable is not named `sqlite3` or is not on `PATH`. Restore with `node scripts/backup.js restore --source <backup-folder> --target <new-unused-folder>`. Restore checks all manifest hashes and runs both SQLite integrity pragmas. It always creates a new directory and never replaces an existing database.

For VPS use, install the SQLite CLI on the host and copy `deploy/backup.env.example` to `/etc/hausa-film-finder/backup.env`, then fill in host paths only. Keep the actual `cloud.env` private and do not source it in a shell. The `scripts/backup-vps.sh` wrapper reads the Compose settings, stops only the `app` service, makes a full consistent backup on the separate mounted destination, and starts the app again even if backup fails. Check that the backup destination is writable and on a different device. Ensure the `hf-backup` service account can access Docker, the persistent volumes, and the destination; restrict its environment file and backup destination to that account.

The example systemd service and timer are templates only. After configuring and reviewing them on the VPS, the timer runs daily at about 03:30; the app is unavailable during the copy and resumes afterward. The project does not enable a timer, configure an external provider, or delete old backups. Keep backups append-only until an operator reviews a separate retention/lifecycle policy. A practical policy is at least 30 daily restore points and 12 month-end copies on encrypted storage outside the VPS; if the provider's lifecycle tools are used later, configure them only after an independent restore check and explicit approval. Keep one additional copy in another account or provider when available.

The archive manifest contains relative file names, sizes, and hashes only; it has no source paths, `.env`, Admin values, API keys, or session secrets. Protect the whole backup folder because it includes authorized movie files and social uploads. This process is a backup tool, not a cloud deployment or media migration.

Example commands, after selecting an existing mounted destination:

```bash
HF_BACKUP_QUIESCED=YES node scripts/backup.js create --destination /mnt/separate-backups \
  --database /srv/hausa-film-finder/database/hausa-film-finder.sqlite \
  --movies /srv/hausa-film-finder/media/movies \
  --merlin-movies /srv/hausa-film-finder/media/movies/merlin \
  --merlin /srv/hausa-film-finder/media/merlin \
  --posters /srv/hausa-film-finder/media/posters \
  --social /srv/hausa-film-finder/media/social

node scripts/backup.js restore --source /mnt/separate-backups/hausa-film-finder-TIMESTAMP \
  --target /srv/restore-rehearsal-TIMESTAMP
```

The VPS wrapper sets the quiesced flag only after Compose has stopped the app and also requires the destination device to differ from the database device. Do not set these acknowledgements manually while the app is running.

## Before the first cloud start

1. Create the VM, firewall, domain, encrypted provider block volumes, and private backup destination. Mount the database, media, Caddy data, and Caddy config volumes at the host paths in `deploy/cloud.env`. Confirm each path is an active mounted volume before creating `deploy/Caddyfile`; Compose refuses to create missing host paths. Ensure the app's database/media directories are writable by the container's `node` user (UID 1000), and that the `10.254.240.0/24` proxy subnet does not overlap the VM's network routes. Do not open the app port directly to the internet.
2. Decide explicitly whether any local data should be transferred. The current database and movie files are not copied into the image or this template. No data transfer has been performed.
3. Install Docker Engine and Compose on the Linux host, then create its private `deploy/cloud.env` file. Set the host volume mount paths to the provider's persistent volumes. Copy `deploy/Caddyfile.example` to `deploy/Caddyfile` and set `PUBLIC_HOST` to the chosen domain.
4. From the project root, on that host, build and start the app privately with `docker compose --env-file deploy/cloud.env -f deploy/compose.yaml up -d --build`. This starts no public proxy and publishes no app port.
5. After the domain, firewall, backup, and public-access approval are ready, start the proxy explicitly with `docker compose --profile public --env-file deploy/cloud.env -f deploy/compose.yaml up -d`. Then check `https://YOUR_DOMAIN/api/health` and configure both website visitors and Android to use `https://YOUR_DOMAIN`.
6. Before accepting uploads, test poster/image matching, short video matching, audio matching, a permitted test upload, fingerprint resume after restart, range playback, and a verified backup restore.

Never run `docker compose down -v` on a host containing project data; removing volumes destroys the persistent database and media.

## Storage estimate from the current local catalogue

The current SQLite data contains 11 movie rows, 10 recorded movie files, 10 Merlin slots, 10 jobs, and 2,204 fingerprint rows. The 10 recorded videos total about 1.92 GiB (about 197 MiB each on average); no recorded movie file was missing. This is a baseline, not a forecast of the full future collection.

Reserve at least twice the source-video total when estimating capacity because some formats need a second Chrome-compatible playback copy. Keep additional room for future uploads, posters, social attachments, backups, and the maximum 30 GiB single upload. A 100 GiB media volume is a reasonable initial planning size for this current collection plus growth; re-estimate from actual file sizes before uploading a much larger collection. Keep database/backups on separately managed durable storage and check free space and restore tests regularly.

## Current deployment status

This template is not a running cloud service. No provider account, domain, certificate, firewall, volume, private secret file, public exposure, or media transfer has been created. Docker and the Android build toolchain were not installed on the inspected development computer, so image/Compose validation and cloud deployment remain outstanding.
