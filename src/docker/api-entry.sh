#!/bin/sh
# The api container's entrypoint (round 8e, docs/vault-owner-brief.md, ADR-105): LifeOS writes the
# notes as the notes folder's owner, with nothing to edit. It starts as root only long enough to
#   1. read the owner (uid:gid) of /vault, the mount's root;
#   2. make LifeOS's own folders that user's when they are not (/data, the data volume, and the
#      passphrase's folder /auth: the folder itself and .env.auth, never anything else in it);
#   3. drop to that user with setpriv (util-linux, from Debian; the Dockerfile checks its version)
#      and exec the command (node), which never runs as root.
# Whose: LIFEOS_UID / LIFEOS_GID when set (never 0); else the folder's owner and group; root's
# (0) is never taken: 1000 instead (the API then logs, as before, that it cannot write).
# Started as another user already (compose's `user:` line, as this host's compose has), it only
# runs the command.
set -eu

if [ "$(id -u)" != 0 ]; then
  exec "$@"
fi

say() { echo "lifeos-api: $*"; }
VAULT="${LIFEOS_VAULT:-/vault}"
DATA="${LIFEOS_DATA:-/data}"
AUTH_FILE="${LIFEOS_AUTH_FILE:-$DATA/.env.auth}"
AUTH_DIR="$(dirname "$AUTH_FILE")"

# a number other than 0, or nothing
id_or_empty() {
  case "$2" in
    '') ;;
    *[!0-9]*) say "$1=$2 is not a number: ignored" >&2 ;;
    *) if [ "$2" -eq 0 ]; then say "$1=0 is root, which LifeOS never runs as: ignored" >&2; else echo "$2"; fi ;;
  esac
}

owner_uid=0
owner_gid=0
if st="$(stat -c '%u %g' "$VAULT" 2>/dev/null)"; then
  owner_uid="${st% *}"
  owner_gid="${st#* }"
fi
uid="$(id_or_empty LIFEOS_UID "${LIFEOS_UID:-}")"
gid="$(id_or_empty LIFEOS_GID "${LIFEOS_GID:-}")"
if [ -n "$uid" ]; then
  how=env
  why="LIFEOS_UID"
elif [ "$owner_uid" != 0 ]; then
  uid="$owner_uid"
  how=folder
  why="the owner of the notes folder"
else
  uid=1000
  how=root-folder
  why="the notes folder belongs to root, which LifeOS never runs as"
fi
# the group: LIFEOS_GID; with LIFEOS_UID alone, the same number; else the folder's (root's: 1000)
if [ -z "$gid" ]; then
  case "$how" in
    env) gid="$uid" ;;
    *) if [ "$owner_gid" != 0 ]; then gid="$owner_gid"; else gid=1000; fi ;;
  esac
fi

# LifeOS's own folders, its user's (an install that ran as another user before keeps its data)
# (one it cannot change, a read-only mount or a squashed share, is said and left: the API then
# names the folder when a write fails)
take() {
  [ -e "$1" ] || return 0
  [ "$(stat -c '%u:%g' "$1")" = "$uid:$gid" ] && return 0
  if chown "$uid:$gid" "$1" 2>/dev/null; then say "made $1 belong to $uid:$gid"; else say "could not make $1 belong to $uid:$gid" >&2; fi
}
mkdir -p "$DATA"
take "$DATA"
for f in "$DATA"/* "$DATA"/.[!.]*; do take "$f"; done
if [ "$AUTH_DIR" != "$DATA" ]; then
  mkdir -p "$AUTH_DIR"
  # a folder of the host's (LIFEOS_AUTH_DIR) is changed only when LifeOS could not write it
  if ! setpriv --reuid="$uid" --regid="$gid" --clear-groups test -w "$AUTH_DIR" -a -x "$AUTH_DIR"; then take "$AUTH_DIR"; fi
  take "$AUTH_FILE"
fi

say "running as $uid:$gid ($why)"
export LIFEOS_RUNAS="$how"
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs -- "$@"
