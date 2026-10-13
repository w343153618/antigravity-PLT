#!/bin/sh
set -eu
. "$(dirname -- "$0")/common.sh"
require_environment
name=${1:-backup-$(date -u +%Y%m%dT%H%M%SZ).db}
validate_backup_name "$name"
compose exec -T erp-app node scripts/storage.ts backup /app/data/app.db "/app/backups/$name"
echo "Consistent SQLite snapshot: $ERP_ROOT/backups/$name"
