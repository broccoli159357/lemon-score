import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { Game } from './game.js';
import { createServer } from './server.js';

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const game = new Game(db, cfg);

// 起動時にも期限切れを処理する（停止していた間の期限切れを含む）
const runCleanup = () => {
  try {
    const n = game.cleanup();
    if (n) console.log(`[cleanup] 期限切れのゲームを ${n} 件削除しました`);
  } catch (e) {
    console.error('[cleanup] 失敗:', e.message);
  }
};
runCleanup();
const timer = setInterval(runCleanup, cfg.cleanupIntervalMs);

const server = createServer(game, cfg);
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`ポート ${cfg.port} は他のアプリが使用中です。PORT=3200 のように別の番号を指定するか、そのアプリを止めてください。`);
  else console.error(`起動できませんでした: ${e.message}`);
  process.exit(1);
});
server.listen(cfg.port, cfg.host, () => {
  console.log(`レモンスコア: http://${cfg.host}:${cfg.port} で待ち受け中 (DB: ${cfg.dbPath}, 公開URL: ${cfg.baseUrl || '(Hostヘッダーから自動)'})`);
});

const shutdown = () => {
  clearInterval(timer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
