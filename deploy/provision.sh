#!/usr/bin/env bash
#
# Provisiona o servidor para rodar o endless-notebook.
# Alvo: Debian 12 / Ubuntu 22.04+ recém-instalado.
#
#   export APP_DOMAIN=notebook.exemplo.com
#   export ACME_EMAIL=voce@exemplo.com
#   export INVITE_CODE='um-codigo-secreto'
#   export DEPLOY_PUBKEY="$(cat ~/endless-deploy.pub)"
#   sudo --preserve-env=APP_DOMAIN,ACME_EMAIL,INVITE_CODE,DEPLOY_PUBKEY bash ~/deploy/provision.sh
#
# É idempotente: pode rodar de novo sem quebrar nada.
set -euo pipefail

: "${APP_DOMAIN:?defina APP_DOMAIN}"
: "${ACME_EMAIL:?defina ACME_EMAIL}"
: "${INVITE_CODE:?defina INVITE_CODE}"
: "${DEPLOY_PUBKEY:?defina DEPLOY_PUBKEY (chave publica que o GitHub Actions vai usar)}"

APP_DIR=/opt/endless-notebook
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo ">> pacotes base"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates ufw fail2ban sqlite3 gnupg

echo ">> firewall (SSH + HTTP + HTTPS)"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo ">> usuario de servico 'endless' (sem login)"
id -u endless >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin endless

echo ">> usuario 'deploy' (CI) + chave"
id -u deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
grep -qF "$DEPLOY_PUBKEY" /home/deploy/.ssh/authorized_keys || echo "$DEPLOY_PUBKEY" >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

echo ">> diretorios da app"
install -d -m 0755 -o endless -g endless "$APP_DIR"
install -d -m 0750 -o endless -g endless "$APP_DIR/data"
install -d -m 0750 -o endless -g endless "$APP_DIR/backups"

echo ">> arquivo de ambiente (segredos)"
if [ ! -f "$APP_DIR/endless-notebook.env" ]; then
  printf 'NOTEBOOK_INVITE_CODE=%s\n' "$INVITE_CODE" > "$APP_DIR/endless-notebook.env"
  chown root:endless "$APP_DIR/endless-notebook.env"
  chmod 640 "$APP_DIR/endless-notebook.env"
else
  echo "   ja existe, mantido"
fi

echo ">> placeholder do binario (o deploy real vem pelo GitHub Actions)"
if [ ! -x "$APP_DIR/endless-notebook" ]; then
  printf '#!/bin/sh\necho "ainda nao publicado"; exit 1\n' > "$APP_DIR/endless-notebook"
  chown endless:endless "$APP_DIR/endless-notebook"
  chmod 0755 "$APP_DIR/endless-notebook"
fi

echo ">> systemd units (app + backup diario)"
install -m 0644 "$REPO_DIR/deploy/endless-notebook.service" /etc/systemd/system/endless-notebook.service
install -m 0755 -o endless -g endless "$REPO_DIR/deploy/backup.sh" "$APP_DIR/backup.sh"
install -m 0644 "$REPO_DIR/deploy/endless-notebook-backup.service" /etc/systemd/system/endless-notebook-backup.service
install -m 0644 "$REPO_DIR/deploy/endless-notebook-backup.timer" /etc/systemd/system/endless-notebook-backup.timer
systemctl daemon-reload
systemctl enable endless-notebook
systemctl enable --now endless-notebook-backup.timer

echo ">> sudoers do deploy"
install -m 0440 "$REPO_DIR/deploy/sudoers-deploy" /etc/sudoers.d/endless-notebook-deploy
visudo -cf /etc/sudoers.d/endless-notebook-deploy

echo ">> Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi
install -d -m 0755 /var/log/caddy
sed -e "s/APP_DOMAIN/${APP_DOMAIN}/g" -e "s/ACME_EMAIL/${ACME_EMAIL}/g" \
  "$REPO_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

echo
echo "== pronto =="
echo "1. Aponte o DNS de ${APP_DOMAIN} (A / AAAA) para o IP deste servidor."
echo "2. No GitHub, rode o workflow 'deploy' (push na main) para publicar o binario."
echo "3. Depois: https://${APP_DOMAIN}/register  (codigo de convite = INVITE_CODE)"
