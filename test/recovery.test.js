import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp, setupRoom, start, playRound, rid } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

const api = (ctx, p) => `/api/rooms/${ctx.roomId}/${p}`;

async function requestRecovery(ctx, nickname) {
  const fresh = app.client();
  const info = await fresh.ok('POST', '/api/invite', { token: ctx.inviteToken });
  assert.equal(info.me, null);
  const names = await fresh.ok('GET', api(ctx, 'recovery/names'));
  // 表示名一覧には役割や数値を含めない
  for (const m of names.members) assert.deepEqual(Object.keys(m).sort(), ['id', 'nickname']);
  const target = names.members.find((m) => m.nickname === nickname);
  await fresh.ok('POST', api(ctx, 'recovery'), { member_id: target.id });
  return { fresh };
}

test('受け入れ21,22,23: 名前を選び、本人以外の誰かの許可で元の参加者に戻る', async () => {
  const ctx = await setupRoom(app, ['B', 'A', 'B'], ['進行', 'えー', 'びー']);
  await start(ctx);
  await playRound(ctx, 2, 3);
  const oldB = ctx.clients[2];
  const { fresh } = await requestRecovery(ctx, 'びー');

  // 承認前：保護データは取得できない・名前を選んだだけでは認証されない
  assert.equal((await fresh.get(api(ctx, 'state'))).status, 401);
  assert.equal((await fresh.get(api(ctx, 'mine'))).status, 401);
  assert.equal((await fresh.ok('GET', api(ctx, 'recovery/status'))).status, 'PENDING');

  // 本人（旧ブラウザ）には確認を出さず、本人は許可できない
  assert.equal((await oldB.ok('GET', api(ctx, 'state'))).recovery_requests.length, 0);
  const hostState = await ctx.host.ok('GET', api(ctx, 'state'));
  const req = hostState.recovery_requests[0];
  assert.equal(req.nickname, 'びー');
  assert.equal((await oldB.post(api(ctx, 'recovery/decide'), { request_id: req.id, approve: true })).status, 403);

  // 進行役でなくても、本人以外なら誰でも許可できる（ここでは飲む人が許可）
  const aState = await ctx.a.ok('GET', api(ctx, 'state'));
  assert.equal(aState.recovery_requests[0].id, req.id);
  await ctx.a.ok('POST', api(ctx, 'recovery/decide'), { request_id: req.id, approve: true });
  const s = await fresh.ok('GET', api(ctx, 'recovery/status'));
  assert.equal(s.status, 'APPROVED');
  const st = await fresh.ok('GET', api(ctx, 'state'));
  assert.equal(st.me.nickname, 'びー');
  assert.equal(st.me.role, 'B');
  assert.equal(st.members.filter((m) => m.role === 'A').length, 1);
  assert.deepEqual(st.b_order.map((b) => b.nickname), ['進行', 'びー']);
  assert.equal(st.current.b_nickname, 'びー');
  assert.equal(st.completed_count, 1);
  // 旧ブラウザの認証情報は使えない
  assert.equal((await oldB.get(api(ctx, 'state'))).status, 401);
  assert.equal((await oldB.post(api(ctx, 'actual'), { request_id: rid(), count: 1 })).status, 401);
  // 新しいブラウザで入力できる
  await fresh.ok('POST', api(ctx, 'actual'), { request_id: rid(), count: 1 });
  // 二度目の受け取りはできない
  const again = await fresh.get(api(ctx, 'recovery/status'));
  assert.notEqual(again.json?.status, 'APPROVED');
});

test('拒否された申請は権限を得られない／認証済みブラウザからのなり替わり申請は禁止', async () => {
  const ctx = await setupRoom(app, ['A', 'B', 'B'], ['あ', 'い', 'う']);
  const { fresh } = await requestRecovery(ctx, 'い');
  const req = (await ctx.host.ok('GET', api(ctx, 'state'))).recovery_requests[0];
  await ctx.host.ok('POST', api(ctx, 'recovery/decide'), { request_id: req.id, approve: false });
  assert.equal((await fresh.ok('GET', api(ctx, 'recovery/status'))).status, 'REJECTED');
  assert.equal((await fresh.get(api(ctx, 'state'))).status, 401);
  // 拒否後も元のブラウザはそのまま使える
  await ctx.clients[1].ok('GET', api(ctx, 'state'));

  const names = await ctx.clients[2].ok('GET', api(ctx, 'recovery/names'));
  const r = await ctx.clients[2].post(api(ctx, 'recovery'), { member_id: names.members.find((m) => m.nickname === 'い').id });
  assert.equal(r.json.error.code, 'ALREADY_AUTHENTICATED');
});

test('申請は10分で失効する', async () => {
  const ctx = await setupRoom(app, ['A', 'B'], ['あ', 'い']);
  const { fresh } = await requestRecovery(ctx, 'い');
  const req = (await ctx.host.ok('GET', api(ctx, 'state'))).recovery_requests[0];
  app.clock.t += 10 * 60_000 + 1;
  try {
    assert.equal((await fresh.ok('GET', api(ctx, 'recovery/status'))).status, 'EXPIRED');
    assert.equal((await ctx.host.post(api(ctx, 'recovery/decide'), { request_id: req.id, approve: true })).status, 404);
  } finally {
    app.clock.t -= 10 * 60_000 + 1;
  }
});

test('受け入れ24: 進行役本人の復帰も他の参加者が許可する／自己承認は不可', async () => {
  const ctx = await setupRoom(app, ['A', 'B', 'B'], ['進行', 'い', 'う']);
  await start(ctx);
  const { fresh } = await requestRecovery(ctx, '進行');
  // 進行役本人（旧ブラウザ）は自分の申請を承認できない
  const hs = await ctx.host.ok('GET', api(ctx, 'state'));
  assert.equal(hs.recovery_requests.length, 0);
  const bs = await ctx.clients[1].ok('GET', api(ctx, 'state'));
  const req = bs.recovery_requests[0];
  assert.equal(req.nickname, '進行');
  assert.equal((await ctx.host.post(api(ctx, 'recovery/decide'), { request_id: req.id, approve: true })).status, 403);
  await ctx.clients[1].ok('POST', api(ctx, 'recovery/decide'), { request_id: req.id, approve: true });
  await fresh.ok('GET', api(ctx, 'recovery/status'));
  const st = await fresh.ok('GET', api(ctx, 'state'));
  assert.equal(st.me.is_host, true);
  assert.equal(st.me.role, 'A');
  assert.equal((await ctx.host.get(api(ctx, 'state'))).status, 401);
  // 進行役がAでも、復帰後に数値は見えない
  await ctx.clients[1].ok('POST', api(ctx, 'actual'), { request_id: rid(), count: 321 });
  assert.ok(!(await fresh.get(api(ctx, 'state'))).text.includes('321'));
});

test('同じ人への申請は最新の1件だけが残る／許可後は他の申請が失効', async () => {
  const ctx = await setupRoom(app, ['B', 'A', 'B'], ['進行', 'えー', 'びー']);
  const r1 = await requestRecovery(ctx, 'えー');
  const r2 = await requestRecovery(ctx, 'えー');
  const reqs = (await ctx.host.ok('GET', api(ctx, 'state'))).recovery_requests;
  assert.equal(reqs.length, 1);
  assert.equal((await r1.fresh.ok('GET', api(ctx, 'recovery/status'))).status, 'EXPIRED');
  // 同時に2人が許可しても、成立するのは1回だけ
  const rs = await Promise.all([ctx.host, ctx.clients[2]].map((c) => c.post(api(ctx, 'recovery/decide'), { request_id: reqs[0].id, approve: true })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 404]);
  assert.equal((await r2.fresh.ok('GET', api(ctx, 'recovery/status'))).status, 'APPROVED');
});

test('受け入れ20: 期限到達・手動削除後は取得も復帰もできない', async () => {
  const ctx = await setupRoom(app, ['A', 'B'], ['あ', 'い']);
  await start(ctx);
  await playRound(ctx, 1, 1);
  await ctx.host.ok('POST', api(ctx, 'finish'), { request_id: rid() });
  // 進行役以外は削除できない、確認なしでは削除しない
  assert.equal((await ctx.clients[1].post(api(ctx, 'delete'), { confirm: true })).status, 403);
  assert.equal((await ctx.host.post(api(ctx, 'delete'), {})).status, 400);
  await ctx.host.ok('POST', api(ctx, 'delete'), { confirm: true });
  for (const c of ctx.clients) assert.equal((await c.get(api(ctx, 'result'))).status, 404);
  assert.equal((await app.client().post('/api/invite', { token: ctx.inviteToken })).status, 404);
  assert.equal((await app.client().get(api(ctx, 'recovery/names'))).status, 404);

  const ctx2 = await setupRoom(app, ['A', 'B'], ['あ', 'い']);
  await start(ctx2);
  await playRound(ctx2, 1, 1);
  await ctx2.host.ok('POST', api(ctx2, 'finish'), { request_id: rid() });
  // 閲覧では期限を延長しない
  const before = (await ctx2.host.ok('GET', api(ctx2, 'result'))).room.expires_at;
  assert.equal(before, app.clock.t + 30 * 86400_000);
  const saved = app.clock.t;
  app.clock.t = before;
  try {
    assert.equal((await ctx2.a.get(api(ctx2, 'result'))).status, 404);
    assert.equal((await app.client().post('/api/invite', { token: ctx2.inviteToken })).status, 404);
    const n = app.game.cleanup();
    assert.ok(n >= 1);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS c FROM members WHERE room_id = ?').get(ctx2.roomId).c, 0);
  } finally {
    app.clock.t = saved;
  }
});

test('期限: 開始前24時間、進行中は最後の操作から72時間', async () => {
  const ctx = await setupRoom(app, ['A', 'B']);
  const t0 = app.clock.t;
  let st = await ctx.host.ok('GET', api(ctx, 'state'));
  assert.equal(st.room.expires_at, t0 + 24 * 3600_000);
  app.clock.t += 3600_000;
  try {
    await start(ctx);
    st = await ctx.host.ok('GET', api(ctx, 'state'));
    assert.equal(st.room.expires_at, app.clock.t + 72 * 3600_000);
  } finally {
    app.clock.t = t0;
  }
});

test('受け入れ26: 再起動してもゲーム中の部屋と確定入力が保持される', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lemon-'));
  const dbPath = path.join(dir, 'db.sqlite');
  const clock = { t: Date.now() };
  const app1 = await startApp({ dbPath, clock });
  const ctx = await setupRoom(app1, ['A', 'B']);
  await start(ctx);
  await playRound(ctx, 4, 5);
  await ctx.clients[1].ok('POST', api(ctx, 'actual'), { request_id: rid(), count: 7 });
  await app1.close();

  const app2 = await startApp({ dbPath, clock });
  try {
    for (const c of ctx.clients) c.base = app2.base;
    const st = await ctx.a.ok('GET', api(ctx, 'state'));
    assert.equal(st.completed_count, 1);
    assert.equal(st.current.phase, 'WAIT_GUESS');
    await ctx.a.ok('POST', api(ctx, 'guess'), { request_id: rid(), round_id: st.current.round_id, version: st.current.round_version, count: 7 });
    await ctx.host.ok('POST', api(ctx, 'finish'), { request_id: rid() });
    const res = await ctx.a.ok('GET', api(ctx, 'result'));
    assert.deepEqual(res.rounds.map((r) => [r.actual_count, r.guess_count]), [[4, 5], [7, 7]]);
  } finally {
    await app2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
