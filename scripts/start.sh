#!/bin/sh
set -eu
. "$(dirname -- "$0")/common.sh"

if [ ! -f .env ]; then cp .env.example .env; fi
chmod 600 .env
for setting in ERP_UID ERP_GID; do
  existing=$(awk -F= -v key="$setting" '$1 == key { print $2 }' .env)
  if [ -z "$existing" ]; then
    case "$setting" in ERP_UID) value=$(id -u) ;; ERP_GID) value=$(id -g) ;; esac
    if [ "$value" -eq 0 ]; then value=1000; fi
    printf '\n%s=%s\n' "$setting" "$value" >> .env
  fi
done
uid=${ERP_UID:-$(awk -F= '$1 == "ERP_UID" { print $2 }' .env)}
gid=${ERP_GID:-$(awk -F= '$1 == "ERP_GID" { print $2 }' .env)}
case "$uid:$gid" in *[!0-9:]*|:*|*:) echo 'ERP_UID and ERP_GID must be positive numeric IDs.' >&2; exit 1 ;; esac
if [ "$uid" -eq 0 ] || [ "$gid" -eq 0 ]; then echo 'Refusing to run the ERP service as root.' >&2; exit 1; fi
mkdir -p data backups
if [ "$(id -u)" -eq 0 ]; then chown "$uid:$gid" data backups; fi
chmod 700 data backups

compose config --quiet
compose up --build --detach --wait --wait-timeout 120
echo 'ERP is healthy. View logs with: docker compose logs --tail 100 erp-app'
