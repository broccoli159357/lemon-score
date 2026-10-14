import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { AppError } from './util.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = {
  '/app.js': 'text/javascript; charset=utf-8',
  '/style.css': 'text/css; charset=utf-8',
  '/favicon.svg': 'image/svg+xml',
  '/manifest.webmanifest': 'application/manifest+json',
};
const SPA_ROUTES = [/^\/$/, /^\/join\/[A-Za-z0-9_-]+$/];

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  // 招待URLのトークンを外部サイトへ Referer で渡さない
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

/** base は公開URL（サブパス込み可。例: https://example.com/lemon） */
export function buildInviteUrl(base, inviteToken) {
  const u = new URL(`${base.replace(/\/+$/, '')}/join/${encodeURIComponent(inviteToken)}`);
  // LINEから押したときに外部ブラウザで開く指定。既存のキーは重複させない。
  u.searchParams.set('openExternalBrowser', '1');
  return u.toString();
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const sessionCookie = (roomId) => `ls_s_${roomId}`;
const waitCookie = (roomId) => `ls_w_${roomId}`;

class RateLimiter {
  constructor(perMinute) {
    this.perMinute = perMinute;
    this.hits = new Map();
  }
  check(key) {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter((t) => now - t < 60_000);
    if (arr.length >= this.perMinute) throw new AppError(429, 'RATE_LIMITED', '操作が多すぎます。少し待ってからもう一度お試しください');
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 10_000) this.hits.clear();
  }
}

export function createServer(game, cfg) {
  const limiter = new RateLimiter(cfg.rateLimitPerMinute);
  const cookieMaxAge = Math.ceil((cfg.finishedTtlMs + cfg.activeTtlMs) / 1000);
  // 公開URLのパス部分（例: BASE_URL=https://example.com/lemon → /lemon）。リバースプロキシがこれを取り除いて転送する前提
  const basePath = cfg.baseUrl ? new URL(cfg.baseUrl).pathname.replace(/\/+$/, '') : '';
  const indexHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    .replace('<base href="/">', `<base href="${basePath}/">`);

  const origin = (req) => {
    if (cfg.baseUrl) return cfg.baseUrl;
    const proto = cfg.trustProxy ? (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() : 'http';
    const host = (cfg.trustProxy && req.headers['x-forwarded-host']) || req.headers.host || `localhost:${cfg.port}`;
    return `${proto}://${host}`;
  };
  const clientIp = (req) => (cfg.trustProxy && req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress) || '?';

  function setCookie(res, name, value, maxAge) {
    const attrs = [`${name}=${encodeURIComponent(value)}`, `Path=${basePath || '/'}`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
    if (cfg.cookieSecure) attrs.push('Secure');
    const prev = res.getHeader('Set-Cookie') || [];
    res.setHeader('Set-Cookie', [...prev, attrs.join('; ')]);
  }

  function send(res, status, body, headers = {}) {
    const isStr = typeof body === 'string' || Buffer.isBuffer(body);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-store',
      'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      ...headers,
    });
    res.end(isStr ? body : JSON.stringify(body));
  }

  async function readJson(req) {
    const ct = req.headers['content-type'] || '';
    if (!ct.startsWith('application/json')) throw new AppError(415, 'BAD_CONTENT_TYPE', 'JSONで送信してください');
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > 16 * 1024) throw new AppError(413, 'TOO_LARGE', '送信データが大きすぎます');
      chunks.push(c);
    }
    if (!size) return {};
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error();
      return v;
    } catch {
      throw new AppError(400, 'BAD_JSON', '送信データが不正です');
    }
  }

  // CSRF対策: 独自ヘッダー必須（クロスオリジンからはプリフライトで止まる）＋ Origin 照合 ＋ SameSite=Lax
  function checkCsrf(req) {
    if (req.headers['x-ls-csrf'] !== '1') throw new AppError(403, 'CSRF', '不正なリクエストです');
    const o = req.headers.origin;
    if (o && o !== new URL(origin(req)).origin) throw new AppError(403, 'CSRF', '不正なリクエストです');
  }

  const routes = [];
  const route = (method, pattern, handler, opts = {}) => routes.push({ method, pattern, handler, opts });

  // ---- 公開（未参加者も呼べる。保護データは返さない）----
  route('POST', /^\/api\/rooms$/, (c) => {
    const r = game.createRoom(c.body);
    setCookie(c.res, sessionCookie(r.roomId), r.sessionToken, cookieMaxAge);
    return { room_id: r.roomId, invite_token: r.inviteToken };
  }, { limit: true });

  route('POST', /^\/api\/invite$/, (c) => {
    const room = game.roomByInvite(c.body.token);
    if (!room) throw new AppError(404, 'NOT_FOUND', 'この招待URLは無効です。期限切れか削除された可能性があります');
    return game.inviteInfo(room, c.cookies[sessionCookie(room.id)], c.cookies[waitCookie(room.id)]);
  }, { limit: true });

  route('POST', /^\/api\/rooms\/([\w-]+)\/join$/, (c) => {
    const r = game.join(c.roomId, c.session, c.body);
    setCookie(c.res, sessionCookie(c.roomId), r.sessionToken, cookieMaxAge);
    return { ok: true };
  }, { limit: true });

  route('GET', /^\/api\/rooms\/([\w-]+)\/recovery\/names$/, (c) => game.recoveryNames(c.roomId), { limit: true });

  route('POST', /^\/api\/rooms\/([\w-]+)\/recovery$/, (c) => {
    const r = game.requestRecovery(c.roomId, c.session, c.body.member_id);
    setCookie(c.res, waitCookie(c.roomId), r.waitToken, Math.ceil(cfg.recoveryRequestTtlMs * 2 / 1000));
    return { nickname: r.nickname, expires_at: r.expires_at };
  }, { limit: true });

  route('GET', /^\/api\/rooms\/([\w-]+)\/recovery\/status$/, (c) => {
    const r = game.recoveryStatus(c.roomId, c.cookies[waitCookie(c.roomId)]);
    if (r.sessionToken) {
      setCookie(c.res, sessionCookie(c.roomId), r.sessionToken, cookieMaxAge);
      setCookie(c.res, waitCookie(c.roomId), '', 0);
    }
    const { sessionToken, ...rest } = r;
    return rest;
  });

  route('GET', /^\/api\/my-rooms$/, (c) => {
    const sessions = Object.entries(c.cookies).filter(([k]) => k.startsWith('ls_s_')).map(([k, v]) => [k.slice(5), v]);
    return { rooms: game.myRooms(sessions) };
  });

  // ---- 参加者（Cookieのセッションで本人を判定）----
  route('GET', /^\/api\/rooms\/([\w-]+)\/state$/, (c) => {
    const s = game.state(c.roomId, c.session);
    if (s.room.invite_token) {
      s.room.invite_url = buildInviteUrl(origin(c.req), s.room.invite_token);
      delete s.room.invite_token;
    }
    return s;
  });

  route('GET', /^\/api\/rooms\/([\w-]+)\/qr\.svg$/, async (c) => {
    const s = game.state(c.roomId, c.session);
    if (s.me.status !== 'APPROVED') throw new AppError(403, 'FORBIDDEN', 'この操作はできません');
    const svg = await QRCode.toString(buildInviteUrl(origin(c.req), s.room.invite_token), { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
    return { raw: svg, type: 'image/svg+xml' };
  });

  route('GET', /^\/api\/rooms\/([\w-]+)\/mine$/, (c) => game.mine(c.roomId, c.session));
  route('GET', /^\/api\/rooms\/([\w-]+)\/result$/, (c) => game.result(c.roomId, c.session));
  route('GET', /^\/api\/rooms\/([\w-]+)\/export\.json$/, (c) => {
    const data = game.exportJson(c.roomId, c.session);
    const d = (data.game.started_at || data.game.created_at).slice(0, 10).replaceAll('-', '');
    return { raw: JSON.stringify(data, null, 2), type: 'application/json; charset=utf-8', headers: { 'Content-Disposition': `attachment; filename="lemon-score-${d}.json"` } };
  });

  const post = (name, fn) => route('POST', new RegExp(`^/api/rooms/([\\w-]+)/${name}$`), fn);
  post('members/approve', (c) => game.approveMember(c.roomId, c.session, c.body.member_id));
  post('members/reject', (c) => game.rejectMember(c.roomId, c.session, c.body.member_id));
  post('members/remove', (c) => game.removeMember(c.roomId, c.session, c.body.member_id));
  post('order', (c) => game.reorder(c.roomId, c.session, c.body.order));
  post('start', (c) => game.start(c.roomId, c.session, c.body.request_id));
  post('actual', (c) => game.submitActual(c.roomId, c.session, c.body));
  post('actual/correct', (c) => game.correctActual(c.roomId, c.session, c.body));
  post('guess', (c) => game.submitGuess(c.roomId, c.session, c.body));
  post('fatigue', (c) => game.setFatigue(c.roomId, c.session, c.body.level ?? null));
  post('skip', (c) => game.skip(c.roomId, c.session, c.body));
  post('void', (c) => game.voidRound(c.roomId, c.session, c.body));
  post('pause', (c) => game.pause(c.roomId, c.session, c.body));
  post('resume', (c) => game.resume(c.roomId, c.session, c.body));
  post('finish', (c) => game.finish(c.roomId, c.session, c.body));
  post('recovery/decide', (c) => game.decideRecovery(c.roomId, c.session, c.body));
  post('delete', (c) => {
    const r = game.deleteRoom(c.roomId, c.session, c.body);
    setCookie(c.res, sessionCookie(c.roomId), '', 0);
    return r;
  });

  function serveStatic(req, res, pathname) {
    if (STATIC[pathname]) {
      send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, pathname)), { 'Content-Type': STATIC[pathname], 'Cache-Control': 'no-cache' });
      return true;
    }
    if (SPA_ROUTES.some((r) => r.test(pathname))) {
      send(res, 200, indexHtml, { 'Content-Type': 'text/html; charset=utf-8' });
      return true;
    }
    return false;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;
    try {
      if (!pathname.startsWith('/api/')) {
        if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, pathname)) return;
        return send(res, 404, 'Not Found');
      }
      for (const r of routes) {
        const m = pathname.match(r.pattern);
        if (!m) continue;
        if (r.method !== req.method) continue;
        if (r.opts.limit) limiter.check(clientIp(req));
        const cookies = parseCookies(req.headers.cookie);
        const ctx = { req, res, cookies, roomId: m[1], body: {} };
        ctx.session = m[1] ? cookies[sessionCookie(m[1])] : undefined;
        if (req.method === 'POST') {
          checkCsrf(req);
          ctx.body = await readJson(req);
        }
        const out = await r.handler(ctx);
        if (out && out.raw !== undefined) return send(res, 200, out.raw, { 'Content-Type': out.type, ...(out.headers || {}) });
        return send(res, 200, out ?? { ok: true });
      }
      throw new AppError(404, 'NOT_FOUND', '見つかりません');
    } catch (e) {
      if (e instanceof AppError) return send(res, e.status, { error: { code: e.code, message: e.message } });
      // 入力値やURLのトークンをログへ出さない
      console.error(`[error] ${req.method} ${pathname.replace(/\/api\/rooms\/[\w-]+/, '/api/rooms/:id')}: ${e?.name}: ${e?.message}`);
      return send(res, 500, { error: { code: 'INTERNAL', message: 'サーバーでエラーが起きました。もう一度お試しください' } });
    }
  }

  return http.createServer((req, res) => {
    handle(req, res);
  });
}
