// 設定値はすべて環境変数から読む。秘密情報・接続情報をソースに置かない。

function int(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`設定 ${name} は0以上の整数で指定してください: ${v}`);
  return n;
}

function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return v === '1' || v.toLowerCase() === 'true';
}

export function loadConfig(overrides = {}) {
  const baseUrl = (overrides.baseUrl ?? process.env.BASE_URL ?? '').replace(/\/+$/, '');
  const cfg = {
    port: int('PORT', 3000),
    host: process.env.HOST || '127.0.0.1',
    // 招待URLの生成に使う公開オリジン（例: https://lemon.example.com）。未設定時はリクエストのHostから組み立てる。
    baseUrl,
    dbPath: process.env.DB_PATH || './data/lemon-score.sqlite',
    // HTTPS前提。ローカル開発時のみ COOKIE_SECURE=0 にする。
    cookieSecure: bool('COOKIE_SECURE', !baseUrl.startsWith('http://')),
    // リバースプロキシ配下で X-Forwarded-For を信用するか（試行制限のIP判定用）
    trustProxy: bool('TRUST_PROXY', false),
    maxCount: int('MAX_COUNT', 999),
    lobbyTtlMs: int('RETENTION_LOBBY_HOURS', 24) * 3600_000,
    activeTtlMs: int('RETENTION_ACTIVE_HOURS', 72) * 3600_000,
    finishedTtlMs: int('RETENTION_FINISHED_DAYS', 30) * 86400_000,
    recoveryRequestTtlMs: int('RECOVERY_REQUEST_MINUTES', 10) * 60_000,
    cleanupIntervalMs: int('CLEANUP_INTERVAL_MINUTES', 10) * 60_000,
    timezone: process.env.TIMEZONE || 'Asia/Tokyo',
    timezoneLabel: process.env.TIMEZONE_LABEL ?? '日本時間',
    rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 60),
    ...overrides,
  };
  return cfg;
}
