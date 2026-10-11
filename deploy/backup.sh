#!/bin/sh
# SQLiteのオンラインバックアップ。cron 例: 15 4 * * * /opt/lemon-score/deploy/backup.sh
# 保持日数は BACKUP_KEEP_DAYS（既定 7日）。30日の画面上の保存期限とは別に、
# 削除したゲームはこの日数が過ぎるまでバックアップに残る。
set -eu
DB="${DB_PATH:-/var/lib/lemon-score/lemon-score.sqlite}"
DIR="${BACKUP_DIR:-/var/backups/lemon-score}"
KEEP="${BACKUP_KEEP_DAYS:-7}"
mkdir -p "$DIR"
chmod 700 "$DIR"
OUT="$DIR/lemon-score-$(date +%Y%m%d-%H%M%S).sqlite"
sqlite3 "$DB" ".backup '$OUT'"
chmod 600 "$OUT"
find "$DIR" -name 'lemon-score-*.sqlite' -mtime +"$KEEP" -delete
