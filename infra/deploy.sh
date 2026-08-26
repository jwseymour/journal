#!/usr/bin/env bash
# Run on the box itself (over SSH), as a sudo-capable user — NOT as the
# unprivileged `journal` service user, which has no login shell.
# Usage: sudo ./deploy.sh <domain>
#   sudo ./infra/deploy.sh journal.example.com
#
# Assumes the repo has already been cloned once into /opt/journal/app and
# /opt/journal/app/.env already exists and is filled in (`docs/deployment.md`
# — first clone and .env are manual, one-time, and involve a git credential
# and secrets that don't belong in a script run by root).
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this with sudo: sudo $0 <domain>" >&2
  exit 1
fi

domain="${1:-}"
if [[ -z "${domain}" ]]; then
  echo "Usage: sudo $0 <domain>" >&2
  exit 1
fi

app_dir="/opt/journal/app"
if [[ ! -d "${app_dir}/.git" ]]; then
  echo "${app_dir} is not a git checkout yet — clone the repo there first (docs/deployment.md)." >&2
  exit 1
fi
if [[ ! -f "${app_dir}/.env" ]]; then
  echo "${app_dir}/.env does not exist yet — fill one in from .env.example first (docs/deployment.md)." >&2
  exit 1
fi

log() { echo "[deploy] $*"; }

log "pulling latest"
sudo -u journal git -C "${app_dir}" pull --ff-only

log "installing dependencies (npm ci, whole workspace — apps/api has no build step, tsx runs the TS directly)"
sudo -u journal bash -c "cd '${app_dir}' && npm ci"

log "installing systemd unit"
cp "${app_dir}/infra/journal-api.service" /etc/systemd/system/journal-api.service
systemctl daemon-reload
systemctl enable journal-api >/dev/null

log "installing Caddy config for ${domain}"
sed "s/{{DOMAIN}}/${domain}/" "${app_dir}/infra/Caddyfile" > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

log "restarting journal-api"
systemctl restart journal-api

log "waiting for the API to come up"
ok=0
for _ in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:4319/health" > /dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done

if [[ "${ok}" -eq 1 ]]; then
  log "OK — /health responded. journal-api is up behind Caddy at https://${domain}"
else
  log "FAILED — /health never responded. Check: journalctl -u journal-api -n 100 --no-pager"
  exit 1
fi
