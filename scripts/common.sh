#!/bin/sh
set -eu
ERP_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ERP_ROOT"
umask 077

compose() {
  docker compose --project-directory "$ERP_ROOT" --env-file "$ERP_ROOT/.env" "$@"
}

require_environment() {
  if [ ! -f .env ]; then
    echo 'Missing .env; run ./scripts/start.sh first or copy .env.example to .env.' >&2
    exit 1
  fi
}

validate_backup_name() {
  case "$1" in
    ''|.*|*[!a-zA-Z0-9_.-]*) echo 'Use a backup filename containing only letters, digits, _, - and dots.' >&2; exit 1 ;;
    *.db) ;;
    *) echo 'Backup filename must end with .db.' >&2; exit 1 ;;
  esac
}
