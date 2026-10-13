#!/bin/sh
set -eu
. "$(dirname -- "$0")/common.sh"
require_environment
name=${1:-}
validate_backup_name "$name"
if [ ! -f "backups/$name" ]; then echo 'Backup file does not exist.' >&2; exit 1; fi

# No process may write this data directory while the database file is replaced.
compose stop --timeout 30 erp-app
running=$(compose ps --status running --quiet erp-app)
if [ -n "$running" ]; then echo 'ERP is still running; restore refused.' >&2; exit 1; fi
if ! compose run --rm --no-deps erp-app node scripts/storage.ts restore "/app/backups/$name" /app/data/app.db /app/backups; then
  echo 'Restore failed; ERP remains stopped. Inspect the error and preserved database before restarting.' >&2
  exit 1
fi
compose up --detach --wait --wait-timeout 120 erp-app
echo 'Restore completed and ERP is healthy. Existing browser sessions must sign in again.'
