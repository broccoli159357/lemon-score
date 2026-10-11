# 運用資料（自前サーバー）

OS・ホスト名・リバースプロキシ・バックアップ先は実際のサーバーに合わせて決める。
以下は Linux + systemd + Caddy または nginx を想定した例。**この資料だけで既存サーバーの設定を変更しないこと。**

## 構成

```
スマートフォン ──HTTPS──▶ リバースプロキシ(443) ──HTTP──▶ アプリ 127.0.0.1:3000 ──▶ SQLite ファイル
```

- 画面とAPIは同じHTTPSオリジン。
- アプリは `127.0.0.1` で待ち受け、外部から直接は接続させない。
- DBはファイル（`DB_PATH`）で、ネットワークに公開しない。

## 初回セットアップ

1. Node.js 24以上と `sqlite3` コマンド（バックアップ用）を入れる。
2. 専用ユーザーとディレクトリを作る。
   ```bash
   sudo useradd --system --home /opt/lemon-score lemon
   sudo mkdir -p /opt/lemon-score /var/lib/lemon-score /var/backups/lemon-score
   sudo chown lemon:lemon /var/lib/lemon-score /var/backups/lemon-score
   ```
3. ソースを `/opt/lemon-score` に置き、`npm ci --omit=dev`（または `npm install`）。
4. `.env.example` を元に `/etc/lemon-score.env` を作り、`chmod 600`。`BASE_URL` に公開URLを設定。
5. `deploy/lemon-score.service` を `/etc/systemd/system/` に置き、
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now lemon-score
   ```
6. リバースプロキシを設定（`deploy/Caddyfile.example` または `deploy/nginx.conf.example`）。
   - Caddy は証明書を自動取得・更新する。
   - nginx は certbot 等で取得し、自動更新（`certbot renew` のタイマー）を有効にする。
   - **招待トークンはURLのパスに入るため、アクセスログにパスを残さない設定にする。**
7. `TRUST_PROXY=1` を設定（試行制限で実際の接続元IPを使うため）。

## 自動起動・再起動

- systemd の `Restart=on-failure` で異常終了時に再起動する。
- 起動時に期限切れのゲームを削除し、その後 `CLEANUP_INTERVAL_MINUTES` ごとに実行する。停止していた期間に期限が来たゲームも起動時に削除される。
- 部屋・杯の記録は SQLite ファイルに保存されるため、再起動・更新で消えない。

## 更新手順

```bash
cd /opt/lemon-score
sudo -u lemon git pull            # またはファイルを差し替え
sudo -u lemon npm ci --omit=dev
npm test                          # 可能なら
sudo systemctl restart lemon-score
```

スキーマは起動時に `CREATE TABLE IF NOT EXISTS` で作成する。将来スキーマを変える場合は移行手順をこの資料に追記する。

## バックアップ

- `deploy/backup.sh` が SQLite のオンラインバックアップを取る（実行中でも整合したコピー）。
- cron 例（毎日 4:15）:
  ```
  15 4 * * * lemon DB_PATH=/var/lib/lemon-score/lemon-score.sqlite /opt/lemon-score/deploy/backup.sh
  ```
- **保持期間は `BACKUP_KEEP_DAYS`（既定7日）。** 画面上の保存期限（終了から30日）や手動削除の後も、削除前に取ったバックアップにはこの日数のあいだデータが残る。画面では「自動で削除されます」とだけ表示し、バックアップからの即時削除は約束しない。
- バックアップファイルはニックネーム・入力値を含むため、権限 600・ディレクトリ 700 で保管する。

## 復元手順

```bash
sudo systemctl stop lemon-score
sudo -u lemon cp /var/backups/lemon-score/lemon-score-YYYYMMDD-HHMMSS.sqlite /var/lib/lemon-score/lemon-score.sqlite
sudo rm -f /var/lib/lemon-score/lemon-score.sqlite-wal /var/lib/lemon-score/lemon-score.sqlite-shm
sudo systemctl start lemon-score
```

復元後、起動時の期限切れ削除により、バックアップ時点以降に期限が来たゲームは削除される。

## ログ

- アプリは1リクエストごとのアクセスログを出さない。エラー時もURLのトークン部分・入力値は出さない（`journalctl -u lemon-score`）。
- リバースプロキシのアクセスログはパスを含めない形式にする（nginx例を参照）。

## 実機確認（受け入れ条件19）

配置後、次を確認して記録する。

| 項目 | 記録 |
| --- | --- |
| 端末・OS | |
| LINEのバージョン | |
| 開いた外部ブラウザとバージョン | |
| LINEのトークで招待URLを押して外部ブラウザで開くか | |
| 参加・入力・再読み込み・結果のコピー | |
| 同じ招待URLを開き直して自動復帰するか | |
| カメラでQRを読み取って参加できるか | |

動作しない環境が見つかった場合は、制限と代替手段（例：URLをコピーしてブラウザに貼る）をREADMEに追記する。
