#!/bin/sh
# lifeos-searxng's start (product brief 10 §1, ADR-92): SearXNG signs with SEARXNG_SECRET. It comes
# from the environment when .env.searxng sets it (older installs, this repo's scripts/start.sh);
# otherwise from a secret made at the first start and kept in the container's own volume
# (/etc/searxng, the searxng-etc volume), so a stack started without install.sh never runs on a
# known secret. Then the image's own entrypoint runs, unchanged. The secret is never printed.
set -eu
f=/etc/searxng/lifeos-secret
if [ -n "${SEARXNG_SECRET:-}" ]; then
  echo "lifeos-searxng: the secret comes from SEARXNG_SECRET (.env.searxng)"
else
  if [ ! -s "$f" ]; then
    if (umask 077 && head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 48 >"$f.tmp" && mv -f "$f.tmp" "$f") 2>/dev/null; then
      echo "lifeos-searxng: made a secret on the first start (kept in the searxng-etc volume)"
    else
      # the volume is not writable for this user: a new secret for this run only
      rm -f "$f.tmp" 2>/dev/null || true
      echo "lifeos-searxng: /etc/searxng is not writable; using a secret for this run only"
      SEARXNG_SECRET="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 48)"
      export SEARXNG_SECRET
    fi
  else
    echo "lifeos-searxng: the secret kept in the searxng-etc volume"
  fi
  if [ -z "${SEARXNG_SECRET:-}" ]; then
    SEARXNG_SECRET="$(cat "$f")"
    export SEARXNG_SECRET
  fi
fi
exec /usr/local/searxng/entrypoint.sh "$@"
