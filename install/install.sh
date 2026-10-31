#!/bin/sh
# Installs CloudSeed with Docker in one step:
#   curl -fsSL https://raw.githubusercontent.com/siyamex/CloudSeed/main/install/install.sh | sh
# Choose another folder or port:  CLOUDSEED_DIR=/srv/cloudseed PORT=9000 sh install.sh
set -eu

DIR="${CLOUDSEED_DIR:-$HOME/cloudseed}"
PORT="${PORT:-8080}"
SRC="${CLOUDSEED_COMPOSE_URL:-https://raw.githubusercontent.com/siyamex/CloudSeed/main/install/docker-compose.yml}"

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install it first: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "Docker Compose (the 'docker compose' command) is missing. Update Docker or install the compose plugin."
docker info >/dev/null 2>&1 || die "Docker is installed but not running, or your user may not use it (try: sudo sh install.sh)."

mkdir -p "$DIR"
cd "$DIR"
say "Installing into $DIR"

if [ -f docker-compose.yml ]; then
  say "Keeping your existing docker-compose.yml."
elif command -v curl >/dev/null 2>&1; then
  curl -fsSL "$SRC" -o docker-compose.yml
else
  wget -qO docker-compose.yml "$SRC"
fi
[ -f .env ] || printf 'PORT=%s\n' "$PORT" > .env
PORT="$(sed -n 's/^PORT=//p' .env | tail -n 1)"
PORT="${PORT:-8080}"

say "Downloading the images (the first time takes a few minutes)..."
docker compose pull -q
docker compose up -d

say "Waiting for it to start..."
i=0
until curl -fsS "http://localhost:$PORT/api/v1/health" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 90 ]; then
    say "It is taking longer than expected. Look at the logs with:  cd $DIR && docker compose logs"
    exit 1
  fi
  sleep 2
done

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
say ""
say "CloudSeed is running."
say "  Open:  http://localhost:$PORT"
[ -n "$IP" ] && say "  or on your network:  http://$IP:$PORT"
say ""
say "The first page asks you to create the administrator account. That is the only setup needed."
say "(If you open it from outside your own network it asks for a setup code:  cd $DIR && docker compose logs api | grep 'setup code')"
say "Stop it:  cd $DIR && docker compose down      Update it:  cd $DIR && docker compose pull && docker compose up -d"
