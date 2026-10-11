import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, setupRoom, start, currentB, playRound, rid } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

const api = (ctx, p) => `/api/rooms/${ctx.roomId}/${p}`;

describe('参加・開始', () => {
  test('招待URLに openExternalBrowser=1 が1つだけ付く', async () => {
    const ctx = await setupRoom(app, ['B', 'A']);
    const st = await ctx.host.ok('GET', api(ctx, 'state'));
    const u = new URL(st.room.invite_url);
    assert.equal(u.origin, 'https://lemon.example.test');
    assert.equal(u.pathname, `/join/${ctx.inviteToken}`);
    assert.deepEqual(u.searchParams.getAll('openExternalBrowser'), ['1']);
    const qr = await ctx.host.get(api(ctx, 'qr.svg'));
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type'), /svg/);
  });

  test('未承認者は参加者用データを読めない', async () => {
    const ctx = await setupRoom(app, ['A', 'B']);
    const x = app.client();
    await x.ok('POST', api(ctx, 'join'), { nickname: '新人', role: 'B' });
    const st = await x.ok('GET', api(ctx, 'state'));
    assert.equal(st.me.status, 'PENDING');
    assert.equal(st.members, undefined);
    assert.equal(st.room.invite_url, undefined);
    assert.equal((await x.get(api(ctx, 'mine'))).status, 403);
    assert.equal((await x.get(api(ctx, 'qr.svg'))).status, 403);
  });

  test('受け入れ3: A枠へ2人が同時に申請しても承認済みAは1人', async () => {
    const ctx = await setupRoom(app, ['B']);
    const [x, y] = [app.client(), app.client()];
    await Promise.all([
      x.ok('POST', api(ctx, 'join'), { nickname: 'エー1', role: 'A' }),
      y.ok('POST', api(ctx, 'join'), { nickname: 'エー2', role: 'A' }),
    ]);
    const st = await ctx.host.ok('GET', api(ctx, 'state'));
    const rs = await Promise.all(st.pending_members.map((p) => ctx.host.post(api(ctx, 'members/approve'), { member_id: p.id })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
    const st2 = await ctx.host.ok('GET', api(ctx, 'state'));
    assert.equal(st2.members.filter((m) => m.role === 'A').length, 1);
    // 以後の参加画面には「Aは参加済み」
    const info = await app.client().ok('POST', '/api/invite', { token: ctx.inviteToken });
    assert.equal(info.a_taken, true);
    const z = await app.client().post(api(ctx, 'join'), { nickname: 'エー3', role: 'A' });
    assert.equal(z.json.error.code, 'A_TAKEN');
  });

  test('名前の重複・長さを検証し、開始条件を守る', async () => {
    const ctx = await setupRoom(app, ['B']);
    const dup = await app.client().post(api(ctx, 'join'), { nickname: ' B0 ', role: 'B' });
    assert.equal(dup.json.error.code, 'NAME_TAKEN');
    assert.equal((await app.client().post(api(ctx, 'join'), { nickname: '   ', role: 'B' })).status, 400);
    assert.equal((await app.client().post(api(ctx, 'join'), { nickname: 'あ'.repeat(21), role: 'B' })).status, 400);
    const r = await ctx.host.post(api(ctx, 'start'), { request_id: rid() });
    assert.equal(r.json.error.code, 'NEED_A');
  });

  test('開始後は新規参加できない', async () => {
    const ctx = await setupRoom(app, ['A', 'B']);
    await start(ctx);
    const r = await app.client().post(api(ctx, 'join'), { nickname: '遅刻', role: 'B' });
    assert.equal(r.json.error.code, 'NOT_JOINABLE');
  });

  test('CSRF: 独自ヘッダーなし・別オリジンは拒否', async () => {
    const c = app.client();
    const r1 = await c.req('POST', '/api/rooms', { nickname: 'x', role: 'A' }, { headers: { 'x-ls-csrf': '0' } });
    assert.equal(r1.status, 403);
    const r2 = await c.req('POST', '/api/rooms', { nickname: 'x', role: 'A' }, { headers: { origin: 'https://evil.example' } });
    assert.equal(r2.status, 403);
  });
});

describe('進行と秘匿', () => {
  test('受け入れ1,2: Bが杯ごとに循環し、伝言なしで複数杯を記録できる', async () => {
    const ctx = await setupRoom(app, ['A', 'B', 'B', 'B'], ['あ', 'い', 'う', 'え']);
    await start(ctx);
    const seen = [];
    for (let i = 0; i < 5; i++) {
      const st = await ctx.host.ok('GET', api(ctx, 'state'));
      seen.push(st.current.b_nickname);
      assert.equal(st.current.number, i + 1);
      await playRound(ctx, i, i);
    }
    assert.deepEqual(seen, ['い', 'う', 'え', 'い', 'う']);
  });

  test('受け入れ4,5: 実投入前の予想・当番以外の入力は拒否', async () => {
    const ctx = await setupRoom(app, ['A', 'B', 'B']);
    await start(ctx);
    const g = await ctx.a.post(api(ctx, 'guess'), { request_id: rid(), round_id: 'x', version: 1, count: 3 });
    assert.equal(g.json.error.code, 'NO_ACTUAL');
    // 当番以外のB
    const notTurn = ctx.clients[2];
    assert.equal((await notTurn.post(api(ctx, 'actual'), { request_id: rid(), count: 3 })).status, 403);
    // Aが実投入を入れようとする
    assert.equal((await ctx.a.post(api(ctx, 'actual'), { request_id: rid(), count: 3 })).status, 403);
    // 別の部屋の参加者
    const other = await setupRoom(app, ['B', 'A']);
    const r = await other.host.req('POST', api(ctx, 'actual'), { request_id: rid(), count: 1 });
    assert.equal(r.status, 401);
    assert.equal((await other.host.get(api(ctx, 'state'))).status, 401);
    // Bが予想を入れようとする
    const b = await currentB(ctx);
    await b.ok('POST', api(ctx, 'actual'), { request_id: rid(), count: 4 });
    const st = await b.ok('GET', api(ctx, 'state'));
    assert.equal((await b.post(api(ctx, 'guess'), { request_id: rid(), round_id: st.current.round_id, version: st.current.round_version, count: 4 })).status, 403);
  });

  test('受け入れ15: 個数の検証', async () => {
    const ctx = await setupRoom(app, ['A', 'B']);
    await start(ctx);
    const b = ctx.clients[1];
    for (const bad of [-1, 1.5, '3', null, 1000, undefined]) {
      const r = await b.post(api(ctx, 'actual'), { request_id: rid(), count: bad });
      assert.equal(r.status, 400, `count=${bad}`);
    }
    await b.ok('POST', api(ctx, 'actual'), { request_id: rid(), count: 0 });
    const st = await ctx.a.ok('GET', api(ctx, 'state'));
    await ctx.a.ok('POST', api(ctx, 'guess'), { request_id: rid(), round_id: st.current.round_id, version: st.current.round_version, count: 999 });
  });

  test('受け入れ6,7,8: 進行役がAでも終了前は実投入数・成績を取得できない', async () => {
    const ctx = await setupRoom(app, ['A', 'B', 'B'], ['あ', 'い', 'う']);
    await start(ctx);
    const SECRET = 417;
    const b = await currentB(ctx);
    await b.ok('POST', api(ctx, 'actual'), { request_id: rid(), count: SECRET });
    const leaks = [];
    for (const p of ['state', 'mine']) {
      const r = await ctx.a.get(api(ctx, p));
      leaks.push(r.text);
      assert.ok(!r.text.includes(String(SECRET)), `A ${p}`);
      assert.ok(!/actual_count|stats|accuracy/.test(r.text), `A ${p} keys`);
    }
    for (const c of ctx.clients) assert.equal((await c.get(api(ctx, 'result'))).status, 403);
    for (const c of ctx.clients) assert.equal((await c.get(api(ctx, 'export.json'))).status, 403);
    // 他のB・進行役のstateにも数値は出ない
    const other = ctx.clients.find((c) => c !== b);
    const o = await other.get(api(ctx, 'state'));
    assert.ok(!o.text.includes(String(SECRET)));
    const om = await other.ok('GET', api(ctx, 'mine'));
    assert.equal(om.rounds.length, 0);
    // 担当Bは専用の操作で自分の値だけ見られる
    const bm = await b.ok('GET', api(ctx, 'mine'));
    assert.equal(bm.rounds[0].actual_count, SECRET);
    // stateには担当Bにも数値を載せない
    assert.ok(!(await b.get(api(ctx, 'state'))).text.includes(String(SECRET)));

    // Aの予想も終了前は本人以外に送らない
    const st = await ctx.a.ok('GET', api(ctx, 'state'));
    await ctx.a.ok('POST', api(ctx, 'guess'), { request_id: rid(), round_id: st.current.round_id, version: st.current.round_version, count: 388 });
    const am = await ctx.a.ok('GET', api(ctx, 'mine'));
    assert.equal(am.rounds[0].guess_count, 388);
    assert.ok(!JSON.stringify(am).includes(String(SECRET)));
    for (const c of ctx.clients.filter((c) => c !== ctx.a)) {
      for (const p of ['state', 'mine']) assert.ok(!(await c.get(api(ctx, p))).text.includes('388'));
    }

    await ctx.host.ok('POST', api(ctx, 'finish'), { request_id: rid() });
    const results = await Promise.all(ctx.clients.map((c) => c.ok('GET', api(ctx, 'result'))));
    const strip = ({ me, ...r }) => r;
    for (const r of results) assert.deepEqual(strip(r), strip(results[0]));
    assert.equal(results[0].rounds[0].actual_count, SECRET);
    assert.equal(results[0].rounds[0].error, 388 - SECRET);
    assert.ok(!results[0].text.includes('lemon.example.test'));
  });

  test('一時停止中は入力を拒否し、再開できる', async () => {
    const ctx = await setupRoom(app, ['A', 'B']);
    await start(ctx);
    await ctx.host.ok('POST', api(ctx, 'pause'), { request_id: rid() });
    const r = await ctx.clients[1].post(api(ctx, 'actual'), { request_id: rid(), count: 1 });
    assert.equal(r.json.error.code, 'PAUSED');
    assert.equal((await ctx.clients[1].post(api(ctx, 'pause'), { request_id: rid() })).status, 403);
    await ctx.host.ok('POST', api(ctx, 'resume'), { request_id: rid() });
    await ctx.clients[1].ok('POST', api(ctx, 'actual'), { request_id: rid(), count: 1 });
  });

  test('スキップ・無効化と杯番号', async () => {
    const ctx = await setupRoom(app, ['A', 'B', 'B'], ['あ', 'い', 'う']);
    await start(ctx);
    // 準備待ちのスキップは杯番号を消費しない
    await ctx.host.ok('POST', api(ctx, 'skip'), { request_id: rid() });
    let st = await ctx.host.ok('GET', api(ctx, 'state'));
    assert.equal(st.current.number, 1);
    assert.equal(st.current.b_nickname, 'う');
    await playRound(ctx, 3, 3); // 1杯目 う
    // 実投入後はスキップ不可 → 無効化で次のBへ
    const b = await currentB(ctx);
    await b.ok('POST', api(ctx, 'actual'), { request_id: rid(), count: 5 });
    assert.equal((await ctx.host.post(api(ctx, 'skip'), { request_id: rid() })).json.error.code, 'ACTUAL_DONE');
    st = await ctx.host.ok('GET', api(ctx, 'state'));
    const open = st.rounds.find((r) => r.status === 'WAIT_GUESS');
    assert.equal((await ctx.host.post(api(ctx, 'void'), { request_id: rid(), round_id: open.id, reason: '' })).status, 400);
    await ctx.host.ok('POST', api(ctx, 'void'), { request_id: rid(), round_id: open.id, reason: 'こぼした' });
    st = await ctx.host.ok('GET', api(ctx, 'state'));
    assert.equal(st.current.number, 3);
    assert.equal(st.current.b_nickname, 'う');
    // 過去の完了杯を無効化しても当番は変わらない
    await ctx.host.ok('POST', api(ctx, 'void'), { request_id: rid(), round_id: st.rounds[0].id, reason: '入力ミス' });
    const st2 = await ctx.host.ok('GET', api(ctx, 'state'));
    assert.equal(st2.current.b_nickname, 'う');
    assert.equal(st2.current.number, 3);
    // 無効理由は終了前は進行役以外へ出さない
    assert.ok(!(await ctx.clients[1].get(api(ctx, 'state'))).text.includes('こぼした'));
    await ctx.host.ok('POST', api(ctx, 'finish'), { request_id: rid() });
    const res = await ctx.a.ok('GET', api(ctx, 'result'));
    assert.equal(res.stats.valid_count, 0);
    assert.equal(res.stats.accuracy, null);
    assert.ok(res.text.includes('無効：第1杯（入力ミス）'));
    assert.ok(res.text.includes('無効：第2杯（こぼした）'));
  });

  test('受け入れ12,13: 予想未確定の杯を無効にして終了／空の準備待ちは結果に混ざらない', async () => {
    const ctx = await setupRoom(app, ['A', 'B']);
    await start(ctx);
    await playRound(ctx, 2, 2);
    await ctx.clients[1].ok('POST', api(ctx, 'actual'), { request_id: rid(), count: 4 });
    const r = await ctx.host.post(api(ctx, 'finish'), { request_id: rid() });
    assert.equal(r.json.error.code, 'OPEN_ROUND');
    await ctx.host.ok('POST', api(ctx, 'finish'), { request_id: rid(), void_open: true });
    const res = await ctx.a.ok('GET', api(ctx, 'result'));
    assert.equal(res.rounds.length, 2);
    assert.equal(res.stats.valid_count, 1);
    assert.equal(res.stats.accuracy, 100);
    assert.equal(res.rounds[1].status, 'VOID');

    const ctx2 = await setupRoom(app, ['A', 'B']);
    await start(ctx2);
    await playRound(ctx2, 1, 2);
    await ctx2.host.ok('POST', api(ctx2, 'finish'), { request_id: rid() });
    const res2 = await ctx2.a.ok('GET', api(ctx2, 'result'));
    assert.equal(res2.rounds.length, 1);
  });

  test('受け入れ14: 0杯で終了', async () => {
    const ctx = await setupRoom(app, ['A', 'B']);
    await start(ctx);
    await ctx.host.ok('POST', api(ctx, 'finish'), { request_id: rid() });
    const res = await ctx.a.ok('GET', api(ctx, 'result'));
    assert.equal(res.rounds.length, 0);
    assert.equal(res.stats.accuracy, null);
    assert.ok(res.text.includes('（—）'));
  });

  test('終了後は入力・無効化・再開を拒否', async () => {
    const ctx = await setupRoom(app, ['A', 'B']);
    await start(ctx);
    await playRound(ctx, 1, 1);
    await ctx.host.ok('POST', api(ctx, 'finish'), { request_id: rid() });
    const st = await ctx.host.ok('GET', api(ctx, 'state'));
    assert.equal((await ctx.clients[1].post(api(ctx, 'actual'), { request_id: rid(), count: 1 })).status, 409);
    assert.equal((await ctx.host.post(api(ctx, 'void'), { request_id: rid(), round_id: st.rounds[0].id, reason: 'x' })).status, 409);
    assert.equal((await ctx.host.post(api(ctx, 'resume'), { request_id: rid() })).status, 409);
  });

  test('疲れ具合はAだけが設定し、予想時点の値を杯に保存する', async () => {
    const ctx = await setupRoom(app, ['A', 'B']);
    await ctx.a.ok('POST', api(ctx, 'fatigue'), { level: 2 });
    assert.equal((await ctx.clients[1].post(api(ctx, 'fatigue'), { level: 1 })).status, 403);
    await start(ctx);
    await playRound(ctx, 1, 1);
    await ctx.a.ok('POST', api(ctx, 'fatigue'), { level: 4 });
    await playRound(ctx, 1, 1);
    await ctx.a.ok('POST', api(ctx, 'fatigue'), { level: null });
    await playRound(ctx, 1, 1);
    // 終了前に他の参加者へは出さない
    assert.ok(!(await ctx.clients[1].get(api(ctx, 'state'))).text.includes('fatigue'));
    await ctx.host.ok('POST', api(ctx, 'finish'), { request_id: rid() });
    const res = await ctx.clients[1].ok('GET', api(ctx, 'result'));
    assert.deepEqual(res.rounds.map((r) => r.fatigue), [2, 4, null]);
  });

  test('JSON書き出しに認証情報・招待トークンを含めない', async () => {
    const ctx = await setupRoom(app, ['A', 'B']);
    await start(ctx);
    await playRound(ctx, 3, 2);
    const st = await ctx.clients[1].ok('GET', api(ctx, 'mine'));
    assert.equal(st.rounds.length, 1);
    await ctx.host.ok('POST', api(ctx, 'finish'), { request_id: rid() });
    const r = await ctx.clients[1].get(api(ctx, 'export.json'));
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /attachment/);
    const j = r.json;
    assert.equal(j.schema_version, 1);
    assert.equal(j.rounds[0].error, -1);
    assert.match(j.game.started_at, /Z$/);
    assert.ok(!r.text.includes(ctx.inviteToken));
    for (const v of ctx.clients[1].jar.values()) assert.ok(!r.text.includes(v));
  });

  test('保護APIはキャッシュさせない', async () => {
    const ctx = await setupRoom(app, ['A', 'B']);
    const r = await ctx.a.get(api(ctx, 'state'));
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });
});

describe('再送・競合', () => {
  test('受け入れ9: 同じrequest_idの再送は二重記録しない／別内容は拒否', async () => {
    const ctx = await setupRoom(app, ['A', 'B']);
    await start(ctx);
    const b = ctx.clients[1];
    const id = rid();
    const [r1, r2] = await Promise.all([
      b.post(api(ctx, 'actual'), { request_id: id, count: 3 }),
      b.post(api(ctx, 'actual'), { request_id: id, count: 3 }),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r1.json.round_id, r2.json.round_id);
    assert.equal((await b.post(api(ctx, 'actual'), { request_id: id, count: 4 })).json.error.code, 'REQUEST_ID_REUSED');
    // 別IDでの二重押しは「記録済み」で拒否
    assert.equal((await b.post(api(ctx, 'actual'), { request_id: rid(), count: 3 })).json.error.code, 'ALREADY_SUBMITTED');
    const st = await ctx.a.ok('GET', api(ctx, 'state'));
    const gid = rid();
    const body = { request_id: gid, round_id: st.current.round_id, version: st.current.round_version, count: 3 };
    const gs = await Promise.all([ctx.a.post(api(ctx, 'guess'), body), ctx.a.post(api(ctx, 'guess'), body)]);
    assert.deepEqual(gs.map((g) => g.status), [200, 200]);
    const mine = await b.ok('GET', api(ctx, 'mine'));
    assert.equal(mine.rounds.length, 1);
    const st2 = await ctx.a.ok('GET', api(ctx, 'state'));
    assert.equal(st2.completed_count, 1);
    assert.equal(st2.current.number, 2);
  });

  test('受け入れ10: 実投入の訂正と予想確定が競合しても片方だけ成立', async () => {
    const ctx = await setupRoom(app, ['A', 'B']);
    await start(ctx);
    const b = ctx.clients[1];
    await b.ok('POST', api(ctx, 'actual'), { request_id: rid(), count: 3 });
    const mine = await b.ok('GET', api(ctx, 'mine'));
    const st = await ctx.a.ok('GET', api(ctx, 'state'));
    const [c, g] = await Promise.all([
      b.post(api(ctx, 'actual/correct'), { request_id: rid(), round_id: mine.rounds[0].id, version: mine.rounds[0].version, count: 5 }),
      ctx.a.post(api(ctx, 'guess'), { request_id: rid(), round_id: st.current.round_id, version: st.current.round_version, count: 4 }),
    ]);
    assert.deepEqual([c.status, g.status].sort(), [200, 409]);
    if (c.status === 200) {
      assert.equal(g.json.error.code, 'ROUND_CHANGED');
      assert.ok(!g.text.includes('5'));
      // 再確認して確定
      const st2 = await ctx.a.ok('GET', api(ctx, 'state'));
      await ctx.a.ok('POST', api(ctx, 'guess'), { request_id: rid(), round_id: st2.current.round_id, version: st2.current.round_version, count: 4 });
    } else {
      assert.equal(c.json.error.code, 'GUESS_DONE');
    }
    await ctx.host.ok('POST', api(ctx, 'finish'), { request_id: rid() });
    const res = await ctx.a.ok('GET', api(ctx, 'result'));
    assert.equal(res.rounds.length, 1);
    assert.equal(res.rounds[0].actual_count, c.status === 200 ? 5 : 3);
  });

  test('訂正後、古い版での予想は拒否され、訂正履歴が書き出される', async () => {
    const ctx = await setupRoom(app, ['A', 'B']);
    await start(ctx);
    const b = ctx.clients[1];
    await b.ok('POST', api(ctx, 'actual'), { request_id: rid(), count: 3 });
    const st = await ctx.a.ok('GET', api(ctx, 'state'));
    const m = await b.ok('GET', api(ctx, 'mine'));
    await b.ok('POST', api(ctx, 'actual/correct'), { request_id: rid(), round_id: m.rounds[0].id, version: m.rounds[0].version, count: 6 });
    // 古い版での訂正も拒否
    assert.equal((await b.post(api(ctx, 'actual/correct'), { request_id: rid(), round_id: m.rounds[0].id, version: m.rounds[0].version, count: 7 })).json.error.code, 'VERSION_CONFLICT');
    const g = await ctx.a.post(api(ctx, 'guess'), { request_id: rid(), round_id: st.current.round_id, version: st.current.round_version, count: 4 });
    assert.equal(g.json.error.code, 'ROUND_CHANGED');
    const st2 = await ctx.a.get(api(ctx, 'state'));
    assert.ok(!st2.text.includes('"6"') && !/actual_count/.test(st2.text));
    await ctx.a.ok('POST', api(ctx, 'guess'), { request_id: rid(), round_id: st2.json.current.round_id, version: st2.json.current.round_version, count: 4 });
    await ctx.host.ok('POST', api(ctx, 'finish'), { request_id: rid() });
    const j = await ctx.a.ok('GET', api(ctx, 'export.json'));
    assert.deepEqual(j.corrections.map((c) => [c.before, c.after]), [[3, 6]]);
  });

  test('受け入れ11: 予想確定と終了が競合しても整合する', async () => {
    for (let i = 0; i < 5; i++) {
      const ctx = await setupRoom(app, ['B', 'A']);
      await start(ctx);
      await ctx.host.ok('POST', api(ctx, 'actual'), { request_id: rid(), count: 2 });
      const st = await ctx.a.ok('GET', api(ctx, 'state'));
      const [g, f] = await Promise.all([
        ctx.a.post(api(ctx, 'guess'), { request_id: rid(), round_id: st.current.round_id, version: st.current.round_version, count: 2 }),
        ctx.host.post(api(ctx, 'finish'), { request_id: rid(), void_open: true }),
      ]);
      assert.equal(f.status, 200);
      const res = await ctx.a.ok('GET', api(ctx, 'result'));
      assert.equal(res.rounds.length, 1);
      if (g.status === 200) assert.equal(res.rounds[0].status, 'COMPLETED');
      else {
        assert.equal(g.json.error.code, 'FINISHED');
        assert.equal(res.rounds[0].status, 'VOID');
        assert.equal(res.rounds[0].guess_count, null);
      }
    }
  });
});
