import crypto from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { Game } from '../src/game.js';
import { createServer } from '../src/server.js';

export async function startApp({ dbPath = ':memory:', clock } = {}) {
  const cfg = loadConfig({ dbPath, baseUrl: 'https://lemon.example.test', cookieSecure: false, rateLimitPerMinute: 100000, port: 0 });
  const db = openDb(dbPath);
  const now = clock ?? { t: Date.UTC(2026, 9, 10, 10, 30) };
  const game = new Game(db, cfg, () => now.t);
  const server = createServer(game, cfg);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    cfg, db, game, base, clock: now,
    client: () => new Client(base),
    close: () => new Promise((r) => server.close(() => { db.close(); r(); })),
  };
}

export const rid = () => crypto.randomBytes(9).toString('base64url');

export class Client {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
  }
  async req(method, p, body, { raw = false, headers = {} } = {}) {
    const h = { ...headers };
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.cookie = cookie;
    if (method === 'POST') {
      h['content-type'] ??= 'application/json';
      h['x-ls-csrf'] ??= '1';
    }
    const res = await fetch(this.base + p, { method, headers: h, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined });
    for (const c of res.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i);
      const v = kv.slice(i + 1);
      if (attrs.some((a) => a.trim() === 'Max-Age=0')) this.jar.delete(k);
      else this.jar.set(k, v);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, body) { return this.req('POST', p, body); }
  /** 2xx以外なら例外 */
  async ok(method, p, body) {
    const r = await this.req(method, p, body);
    if (r.status !== 200) throw new Error(`${method} ${p} -> ${r.status} ${r.text}`);
    return r.json;
  }
  /** クッキーを全部捨てる（別ブラウザ相当） */
  clone() {
    const c = new Client(this.base);
    c.jar = new Map(this.jar);
    return c;
  }
}

/** 進行役(作成者)+参加者で部屋を作り、全員承認する。roles: 例 ['A','B','B']（先頭が進行役） */
export async function setupRoom(app, roles, names) {
  names ??= roles.map((r, i) => `${r}${i}`);
  const clients = roles.map(() => app.client());
  const host = clients[0];
  const created = await host.ok('POST', '/api/rooms', { nickname: names[0], role: roles[0] });
  const roomId = created.room_id;
  for (let i = 1; i < roles.length; i++) {
    await clients[i].ok('POST', '/api/invite', { token: created.invite_token });
    await clients[i].ok('POST', `/api/rooms/${roomId}/join`, { nickname: names[i], role: roles[i] });
  }
  const st = await host.ok('GET', `/api/rooms/${roomId}/state`);
  for (const p of st.pending_members) await host.ok('POST', `/api/rooms/${roomId}/members/approve`, { member_id: p.id });
  const states = await Promise.all(clients.map((c) => c.ok('GET', `/api/rooms/${roomId}/state`)));
  const ids = states.map((s) => s.me.id);
  const aIdx = roles.indexOf('A');
  return { roomId, inviteToken: created.invite_token, clients, host, ids, a: clients[aIdx], aIdx };
}

export async function start(ctx) {
  return ctx.host.ok('POST', `/api/rooms/${ctx.roomId}/start`, { request_id: rid() });
}

/** 現在の当番Bのクライアントを返す */
export async function currentB(ctx) {
  const st = await ctx.host.ok('GET', `/api/rooms/${ctx.roomId}/state`);
  return ctx.clients[ctx.ids.indexOf(st.current.b_member_id)];
}

/** 1杯を完了させる */
export async function playRound(ctx, actual, guess) {
  const b = await currentB(ctx);
  await b.ok('POST', `/api/rooms/${ctx.roomId}/actual`, { request_id: rid(), count: actual });
  const st = await ctx.a.ok('GET', `/api/rooms/${ctx.roomId}/state`);
  await ctx.a.ok('POST', `/api/rooms/${ctx.roomId}/guess`, { request_id: rid(), round_id: st.current.round_id, version: st.current.round_version, count: guess });
}
