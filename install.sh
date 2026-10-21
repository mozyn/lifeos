#!/usr/bin/env bash
# LifeOS installer for Linux and macOS (on Windows: install.ps1, or this script inside WSL). It is
# optional: on a NAS, or anywhere with Dockge, set three values in .env and Deploy instead (README,
# "Install on a NAS"). It checks Docker, fills in .env, asks for your notes folder (or makes a new,
# empty one: LifeOS puts the starter notes in it when it first starts), builds and starts LifeOS,
# and prints the address. The search secret and the notification keys LifeOS makes itself.
# Run it again at any time: it keeps what is already set up.
#
# It asks questions; each can be answered ahead by an environment variable instead:
#   LIFEOS_INSTALL_VAULT=/path/to/notes   your notes folder, or where to make a new one
#   LIFEOS_INSTALL_STARTER=1              make that folder for the starter notes (it must be new or empty)
#   LIFEOS_INSTALL_PORT=8480              the port
#   LIFEOS_INSTALL_AI_URL=… LIFEOS_INSTALL_AI_MODEL=… LIFEOS_INSTALL_AI_KEY=…   a model on your computer or network
#   LIFEOS_INSTALL_TELEGRAM_TOKEN=… LIFEOS_INSTALL_TELEGRAM_CHAT=…              Telegram reminders
#   LIFEOS_INSTALL_YES=1                  ask nothing (use the variables above and the defaults)
set -euo pipefail
cd "$(dirname "$0")"
HERE="$(pwd -P)"

say() { printf '%s\n' "$*"; }
die() {
  printf '\ninstall.sh: %s\n' "$*" >&2
  exit 1
}
interactive() { [ "${LIFEOS_INSTALL_YES:-}" != 1 ] && [ -t 0 ]; }
# ask "question" "default": the answer in REPLY (the default when nobody is asked)
ask() {
  REPLY="$2"
  if interactive; then
    if [ -n "$2" ]; then printf '%s [%s]: ' "$1" "$2"; else printf '%s: ' "$1"; fi
    IFS= read -r REPLY || true
    [ -n "$REPLY" ] || REPLY="$2"
  fi
}
# .env helpers: read one value; set one value where its line is (so the comments stay beside it),
# or at the end when .env has no such line
getenv() { [ -f .env ] && sed -n "s/^$1=//p" .env | tail -1 || true; }
setenv() {
  local tmp
  tmp="$(mktemp "$HERE/.env.XXXXXX")"
  K="$1" V="$2" awk 'index($0, ENVIRON["K"] "=") == 1 { if (!done) print ENVIRON["K"] "=" ENVIRON["V"]; done = 1; next } { print } END { if (!done) print ENVIRON["K"] "=" ENVIRON["V"] }' .env >"$tmp"
  cat "$tmp" >.env
  rm -f "$tmp"
}

say "LifeOS: installing in $HERE"

# ---------------------------------------------------------------- 1. Docker
command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install Docker Desktop (macOS, Windows) or Docker Engine (Linux) first: https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing ('docker compose version' failed). Update Docker."
docker info >/dev/null 2>&1 || die "Docker is installed but not running, or this user may not use it. Start Docker Desktop; on Linux, add yourself to the 'docker' group and log in again."

# ---------------------------------------------------------------- 2. .env (made when missing: the folder ships one file, compose.yaml)
[ -f .env ] || printf 'LIFEOS_NAME=\nLIFEOS_VAULT_HOST=\nLIFEOS_UID=\nLIFEOS_GID=\nLIFEOS_PORT=\nTZ=\n' >.env
chmod 600 .env 2>/dev/null || true
NAME="$(getenv LIFEOS_NAME)"
NAME="${NAME:-lifeos}"
dc() { docker compose -p "$NAME" "$@"; }

# ---------------------------------------------------------------- 3. the notes folder
vault="$(getenv LIFEOS_VAULT_HOST)"
fresh=0
if [ -z "$vault" ]; then
  vault="${LIFEOS_INSTALL_VAULT:-}"
  starter="${LIFEOS_INSTALL_STARTER:-}"
  if [ -z "$vault" ] && interactive; then
    say ""
    say "LifeOS works on a folder of plain .md notes: an Obsidian vault, or any folder."
    say "  1) Use a folder I already have"
    say "  2) Make a new folder with a few starter notes"
    ask "Choose 1 or 2" "2"
    if [ "$REPLY" = 1 ]; then
      ask "The path of your notes folder" ""
      vault="$REPLY"
      starter=0
    else
      ask "Where should the new folder go" "$HERE/my-notes"
      vault="$REPLY"
      starter=1
    fi
  fi
  [ -n "$vault" ] || die "No notes folder: set LIFEOS_INSTALL_VAULT=/path (and LIFEOS_INSTALL_STARTER=1 for a new one), or run me in a terminal."
  case "$vault" in "~"*) vault="$HOME${vault#\~}" ;; esac
  case "$vault" in /*) ;; *) vault="$HERE/$vault" ;; esac
  if [ "${starter:-0}" = 1 ]; then
    if [ -d "$vault" ] && [ -n "$(ls -A "$vault" 2>/dev/null)" ]; then die "$vault is not empty. The starter notes go into a new or empty folder."; fi
    mkdir -p "$vault"
    fresh=1
  fi
  [ -d "$vault" ] || die "$vault is not a folder."
  [ -w "$vault" ] || die "$vault is not writable by $(id -un). LifeOS writes your notes as you."
  setenv LIFEOS_VAULT_HOST "$vault"
fi
say "Notes folder: $vault"

# the notes' owner: the API writes as this user, so new and changed notes stay yours
[ -n "$(getenv LIFEOS_UID)" ] && [ "$(getenv LIFEOS_UID)" != 1000 ] || setenv LIFEOS_UID "$(id -u)"
[ -n "$(getenv LIFEOS_GID)" ] && [ "$(getenv LIFEOS_GID)" != 1000 ] || setenv LIFEOS_GID "$(id -g)"

# ---------------------------------------------------------------- 4. port and time zone
port="${LIFEOS_INSTALL_PORT:-$(getenv LIFEOS_PORT)}"
port="${port:-8480}"
running="$(dc ps -q web 2>/dev/null || true)"
if [ -z "$running" ] && (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
  if interactive; then
    ask "Port $port is in use on this computer. Which port should LifeOS use" "$((port + 1))"
    port="$REPLY"
  else
    die "Port $port is in use. Set LIFEOS_INSTALL_PORT (or LIFEOS_PORT in .env) to a free one."
  fi
fi
setenv LIFEOS_PORT "$port"
if [ "$(getenv TZ)" = UTC ] || [ -z "$(getenv TZ)" ]; then
  tz="$( (readlink /etc/localtime 2>/dev/null || true) | sed -n 's#.*zoneinfo/##p')"
  [ -n "$tz" ] || tz="$(cat /etc/timezone 2>/dev/null || true)"
  [ -n "$tz" ] && setenv TZ "$tz"
fi

# ---------------------------------------------------------------- 5. optional secrets (each in its own file, readable by you only)
if interactive && [ -z "${LIFEOS_INSTALL_AI_URL:-}${LIFEOS_INSTALL_TELEGRAM_TOKEN:-}" ] && { [ ! -f .env.ai ] || [ ! -f .env.telegram ]; }; then
  say ""
  say "Recommended: connect Hermes, your own AI agent, once LifeOS is running (Settings → Hermes)."
  say "It drafts your plans with its model and sends your reminders on Telegram. The questions"
  say "below are for running without Hermes; press Enter to skip them."
fi
if [ ! -f .env.ai ]; then
  ai_url="${LIFEOS_INSTALL_AI_URL:-}"
  if [ -z "$ai_url" ] && interactive; then
    say ""
    say "Optional: a model on this computer or your network can draft your morning plan and evening review"
    say "(llama.cpp, Ollama, LM Studio, vLLM...). You can also choose one later in Settings, or none."
    ask "Its OpenAI-compatible address (Enter to skip), for example http://host.docker.internal:11434/v1" ""
    ai_url="$REPLY"
  fi
  if [ -n "$ai_url" ]; then
    ai_model="${LIFEOS_INSTALL_AI_MODEL:-}"
    [ -n "$ai_model" ] || { ask "The model name" ""; ai_model="$REPLY"; }
    ai_key="${LIFEOS_INSTALL_AI_KEY:-}"
    (umask 077 && printf 'AI_PROVIDER=local\nAI_BASE_URL=%s\nAI_MODEL=%s\nAI_API_KEY=%s\n' "$ai_url" "$ai_model" "$ai_key" >.env.ai)
    say "Wrote .env.ai (a local model)."
  fi
fi
if [ ! -f .env.telegram ]; then
  tg_token="${LIFEOS_INSTALL_TELEGRAM_TOKEN:-}"
  if [ -z "$tg_token" ] && interactive; then
    say ""
    say "Optional: reminders can also come as Telegram messages from your own bot (see the README)."
    ask "Bot token from @BotFather (Enter to skip)" ""
    tg_token="$REPLY"
  fi
  if [ -n "$tg_token" ]; then
    tg_chat="${LIFEOS_INSTALL_TELEGRAM_CHAT:-}"
    [ -n "$tg_chat" ] || { ask "Your chat id with the bot" ""; tg_chat="$REPLY"; }
    (umask 077 && printf 'TELEGRAM_BOT_TOKEN=%s\nTELEGRAM_CHAT_ID=%s\n' "$tg_token" "$tg_chat" >.env.telegram)
    say "Wrote .env.telegram."
  fi
fi

# ---------------------------------------------------------------- 6. build and start
# (the search secret, the notifications' key pair and an empty folder's starter notes are made by
# LifeOS itself on its first start)
export LIFEOS_BUILD="$(sed -n 's/^commit=//p' VERSION 2>/dev/null || echo dev)"
say ""
say "Building LifeOS (the first time takes a few minutes)..."
dc build
say "Starting LifeOS..."
dc up -d --wait --wait-timeout 300
[ "$fresh" = 1 ] && say "Starter notes: $(find "$vault" -name '*.md' | wc -l | tr -d ' ') notes in $vault"
say ""
say "LifeOS is running: http://localhost:$port/lifeos/"
say "Open it in your browser, choose a passphrase, then tell it where you are."
say "Then connect Hermes: Settings → Hermes → Create token, and paste the prompt in your Hermes chat."
say "Stop it: docker compose -p $NAME stop   Start again: docker compose -p $NAME up -d   Remove: ./uninstall.sh"
