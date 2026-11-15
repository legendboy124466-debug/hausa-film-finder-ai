#!/usr/bin/env bash
set -Eeuo pipefail

: "${HF_PROJECT_ROOT:?Set HF_PROJECT_ROOT in the private backup environment file}"
: "${HF_COMPOSE_FILE:?Set HF_COMPOSE_FILE in the private backup environment file}"
: "${HF_COMPOSE_ENV_FILE:?Set HF_COMPOSE_ENV_FILE in the private backup environment file}"
: "${HF_DATABASE_HOST_PATH:?Set HF_DATABASE_HOST_PATH to the persistent host database volume}"
: "${HF_MEDIA_HOST_PATH:?Set HF_MEDIA_HOST_PATH to the persistent host media volume}"
: "${HF_BACKUP_DESTINATION:?Set HF_BACKUP_DESTINATION to a separate mounted backup device}"

cd "$HF_PROJECT_ROOT"
compose=(docker compose --env-file "$HF_COMPOSE_ENV_FILE" -f "$HF_COMPOSE_FILE")
was_running="$("${compose[@]}" ps --status running -q app)"
restart_app=0
if [[ -n "$was_running" ]]; then restart_app=1; fi

restore_app() {
    local status=$?
    trap - EXIT
    if (( restart_app )); then
        "${compose[@]}" start app >/dev/null || status=1
    fi
    exit "$status"
}
trap restore_app EXIT

"${compose[@]}" stop app >/dev/null
export HF_BACKUP_QUIESCED=YES
export HF_BACKUP_REQUIRE_SEPARATE_DEVICE=1
export SQLITE3_PATH="${HF_SQLITE3_PATH:-sqlite3}"

node scripts/backup.js create \
    --destination "$HF_BACKUP_DESTINATION" \
    --database "$HF_DATABASE_HOST_PATH/hausa-film-finder.sqlite" \
    --movies "$HF_MEDIA_HOST_PATH/movies" \
    --merlin-movies "$HF_MEDIA_HOST_PATH/movies/merlin" \
    --merlin "$HF_MEDIA_HOST_PATH/merlin" \
    --posters "$HF_MEDIA_HOST_PATH/posters" \
    --social "$HF_MEDIA_HOST_PATH/social"
