#!/usr/bin/env bash
#
# Backup consistente do SQLite (usa a API de online-backup, seguro com a app rodando).
# Instalado em /opt/endless-notebook/backup.sh e disparado pelo timer systemd.
set -euo pipefail

DB=/opt/endless-notebook/data/notebook.db
DEST=/opt/endless-notebook/backups
KEEP=14

mkdir -p "$DEST"
stamp=$(date +%Y%m%d-%H%M%S)
out="$DEST/notebook-$stamp.db"

sqlite3 "$DB" ".backup '$out'"
gzip -9 "$out"

# retencao: mantem os KEEP mais recentes
ls -1t "$DEST"/notebook-*.db.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "backup ok: ${out}.gz"
