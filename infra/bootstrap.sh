#!/usr/bin/env bash
# EC2 user-data: runs once, as root, on first boot (`infra/terraform/main.tf`).
#
# Installs the OS-level prerequisites only — Node, Caddy, a service user and
# the directories it owns. Deliberately does NOT clone the repo or start
# anything that depends on `.env` secrets, none of which exist yet at first
# boot. That happens later, over SSH, as `docs/deployment.md` walks through
# — cloning a private repo needs its own credential (a deploy key), which is
# exactly the kind of thing that does not belong baked into instance
# user-data (visible via the instance metadata service to anything with API
# access to the account).
set -euo pipefail

log() { echo "[bootstrap] $*"; }

export DEBIAN_FRONTEND=noninteractive

log "apt update/upgrade"
apt-get update -y
apt-get upgrade -y

log "installing base packages"
apt-get install -y ca-certificates curl gnupg git

# `better-sqlite3`, `sqlite-vec` and `argon2` all compile native addons on
# install (`npm ci`) — nothing upstream of this script depends on them being
# prebuilt for arm64, so a real toolchain has to be here already, not added
# ad hoc later.
log "installing build toolchain for native npm modules (better-sqlite3, argon2, ...)"
apt-get install -y build-essential python3

# ── Node 20.x, matching this repo's engines constraint (>=20.9.0) ─────────
log "installing Node 20.x"
mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
apt-get update -y
apt-get install -y nodejs

# ── Caddy — automatic HTTPS via Let's Encrypt, real config added at deploy
# time once the domain is known (`infra/Caddyfile`, `infra/deploy.sh`) ─────
log "installing Caddy"
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y
apt-get install -y caddy

# ── Service user and directories ───────────────────────────────────────────
log "creating service user"
if ! id -u journal >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /opt/journal --shell /usr/sbin/nologin journal
fi

mkdir -p /opt/journal/app          # the cloned repo goes here
mkdir -p /opt/journal/data         # index.db, model caches, the local git mirror (JOURNAL_DIR)
chown -R journal:journal /opt/journal

# ── Swap ─────────────────────────────────────────────────────────────────
#
# `t4g.micro` (the default `instance_type`) has ~900MB of RAM, and `npm ci`
# compiling three native addons at once reliably gets OOM-killed without
# this — observed directly, not a theoretical concern. Cheap and harmless
# on a bigger instance type too, so it's unconditional rather than sized to
# `var.instance_type`.
if ! swapon --show | grep -q /swapfile; then
  log "creating 2GB swap file"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "bootstrap complete. Next: SSH in, clone the repo into /opt/journal/app, fill in /opt/journal/app/.env, then run infra/deploy.sh (see docs/deployment.md)."
