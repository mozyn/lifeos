#!/usr/bin/env bash
# Update this LifeOS folder from a newer copy of it, in place. Your settings (.env and the other
# .env.* files), your passphrase, LifeOS's database and your notes are kept; the program files
# (src/ with the starter notes, compose.yaml, the scripts, the README) are replaced, then LifeOS is
# rebuilt and restarted. (In Dockge: copy the new src/ and compose.yaml over, keep .env, and
# Update; see the README.)
#   ./update.sh /path/to/new/lifeos-portable          a folder
#   ./update.sh /path/to/lifeos-portable.tar.gz       an archive of one (.tar.gz or .zip)
#   ./update.sh https://example.com/lifeos-portable.tar.gz
set -euo pipefail
cd "$(dirname "$0")"
HERE="$(pwd -P)"
die() {
  printf 'update.sh: %s\n' "$*" >&2
  exit 1
}
src="${1:-}"
[ -n "$src" ] || die "usage: ./update.sh <new folder | archive | https URL of an archive>"
[ -f .env ] || die "this folder has no .env: run ./install.sh first"

work="$(mktemp -d "${TMPDIR:-/tmp}/lifeos-update.XXXXXX")"
trap 'rm -rf "$work"' EXIT
case "$src" in
  https://*)
    command -v curl >/dev/null || die "curl is needed to download $src"
    curl -fsSL "$src" -o "$work/new.tar.gz"
    src="$work/new.tar.gz"
    ;;
esac
if [ -f "$src" ]; then
  mkdir -p "$work/x"
  case "$src" in
    *.zip) command -v unzip >/dev/null || die "unzip is needed for $src"; unzip -q "$src" -d "$work/x" ;;
    *) tar -xzf "$src" -C "$work/x" ;;
  esac
  src="$(dirname "$(find "$work/x" -name VERSION -maxdepth 3 | head -1)")"
fi
[ -f "$src/VERSION" ] && [ -f "$src/compose.yaml" ] && [ -d "$src/src" ] || die "$src does not look like a LifeOS folder (VERSION, compose.yaml and src/ expected)"
src="$(cd "$src" && pwd -P)"
[ "$src" != "$HERE" ] || die "that is this folder"

say_version() { sed -n 's/^version=//p;s/^commit=/  /p' "$1/VERSION" | tr -d '\n'; }
printf 'Updating LifeOS %s to %s\n' "$(say_version "$HERE")" "$(say_version "$src")"

# the program files only; never .env*, the passphrase, a notes folder kept in here, or the data volume
vault="$(sed -n 's/^LIFEOS_VAULT_HOST=//p' .env | tail -1)"
vault_real="$(if [ -n "$vault" ] && cd "$vault" 2>/dev/null; then pwd -P; fi)"
rm -rf src
cp -R "$src/src" src
for f in compose.yaml README.md LICENSE VERSION install.sh install.ps1 update.sh uninstall.sh; do
  [ -f "$src/$f" ] && cp "$src/$f" "$f"
done
chmod +x install.sh update.sh uninstall.sh 2>/dev/null || true
# what older versions had beside them (the starter notes now live in src/; .env is the template):
# gone, unless the notes folder is one of them
for old in starter-vault .env.example; do
  if [ -e "$old" ] && [ "$HERE/$old" != "$vault_real" ]; then rm -rf "$old"; fi
done

# settings that are new in this version (they have defaults; add them to .env to change them)
new="$(grep -oE '^[A-Z_]+=' "$src/.env" 2>/dev/null | tr -d = | while read -r k; do grep -q "^$k=" .env || printf '%s ' "$k"; done)"
[ -z "$new" ] || printf 'New settings in the new .env (defaults apply; copy the lines you want into yours): %s\n' "$new"

NAME="$(sed -n 's/^LIFEOS_NAME=//p' .env | tail -1)"
NAME="${NAME:-lifeos}"
export LIFEOS_BUILD="$(sed -n 's/^commit=//p' VERSION)"
docker compose -p "$NAME" up -d --build --wait --wait-timeout 300
printf 'Updated. LifeOS is running: http://localhost:%s/lifeos/\n' "$(sed -n 's/^LIFEOS_PORT=//p' .env | tail -1)"
