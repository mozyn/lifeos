#!/usr/bin/env bash
# Stop LifeOS and remove its containers and network. It asks before deleting its volumes: the
# database and the search cache (LifeOS rebuilds its database from your notes, so that loses only
# settings, drafts, search history and, unless LIFEOS_AUTH_DIR keeps it in a folder, the
# passphrase). Your notes folder is never touched.
#   ./uninstall.sh              asks
#   ./uninstall.sh --volumes    also delete the volumes, without asking
#   ./uninstall.sh --keep       keep the volumes, without asking
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "uninstall.sh: nothing installed here (no .env)"; exit 0; }
NAME="$(sed -n 's/^LIFEOS_NAME=//p' .env | tail -1)"
NAME="${NAME:-lifeos}"
# compose reads the whole file even to remove it: a folder never set up still has to name one
grep -q '^LIFEOS_VAULT_HOST=.' .env || export LIFEOS_VAULT_HOST=/nonexistent
volumes="${LIFEOS_UNINSTALL_VOLUMES:-}"
case "${1:-}" in
  --volumes) volumes=1 ;;
  --keep) volumes=0 ;;
esac
if [ -z "$volumes" ]; then
  if [ -t 0 ]; then
    printf 'Also delete LifeOS'"'"'s database and search cache? Your notes are not affected. [y/N]: '
    IFS= read -r a || true
    case "$a" in y | Y | yes) volumes=1 ;; *) volumes=0 ;; esac
  else
    volumes=0
  fi
fi
if [ "$volumes" = 1 ]; then
  docker compose -p "$NAME" down -v --remove-orphans
  echo "LifeOS is removed, with its database and search cache. Your notes are where they were."
else
  docker compose -p "$NAME" down --remove-orphans
  echo "LifeOS is stopped and its containers are removed; its database is kept (./install.sh brings it back)."
fi
echo "This folder, its .env files and your notes are untouched; delete this folder yourself if you want it gone."
