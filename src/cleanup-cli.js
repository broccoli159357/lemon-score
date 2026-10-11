// 期限切れデータの削除を手動・cron から実行する
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { Game } from './game.js';

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const n = new Game(db, cfg).cleanup();
console.log(`期限切れのゲームを ${n} 件削除しました`);
db.close();
