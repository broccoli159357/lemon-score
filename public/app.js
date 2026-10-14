'use strict';
// レモンスコア クライアント。
// 未公開の数値はサーバーが役割に応じて返さないため、ここで「隠す」処理はしない。
// ユーザー入力（ニックネーム・理由）は必ず textContent で表示し、HTMLとして解釈しない。

const POLL_MS = 2500;
const ROLE_LABEL = { A: '飲む人', B: '入れる人' };
const ROLE_HELP = { A: '飲んで個数を当てる（1人）', B: 'レモンを入れる（交代で担当）' };

// サブパス（例: https://example.com/lemon/）でも動くよう、<base href> からベースパスを得る。
// 画面内のパスはすべて「ベースパス抜き」で書き、通信・リンク・履歴の直前に付け足す。
const BASE = new URL(document.baseURI).pathname.replace(/\/+$/, '');
const withBase = (p) => (p.startsWith('/') ? BASE + p : p);
const $app = document.getElementById('app');
const $net = document.getElementById('net');

// ---------- 小さなユーティリティ ----------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (v === true) el.setAttribute(k, '');
    else if ((k === 'href' || k === 'src') && typeof v === 'string') el.setAttribute(k, withBase(v));
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const rid = () => {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function api(method, path, body) {
  const opt = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' };
  if (method === 'POST') {
    opt.headers['Content-Type'] = 'application/json';
    opt.headers['X-LS-CSRF'] = '1';
    opt.body = JSON.stringify(body || {});
  }
  let res;
  try {
    res = await fetch(withBase(path), opt);
  } catch {
    setOnline(false);
    return { ok: false, network: true, error: { code: 'NETWORK', message: '通信できませんでした。電波の良い場所でもう一度お試しください' } };
  }
  setOnline(true);
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) return { ok: false, status: res.status, error: data?.error || { code: 'HTTP', message: `エラーが起きました（${res.status}）` } };
  return { ok: true, data };
}

function setOnline(on) { $net.hidden = on; }

// 再描画しても、開いている折りたたみ欄はそのままにする
const openDetails = new Set();
document.addEventListener('toggle', (e) => {
  const k = e.target?.dataset?.key;
  if (k) e.target.open ? openDetails.add(k) : openDetails.delete(k);
}, true);

function mount(...nodes) {
  // 再描画でフォーカスと入力中の位置を保つ
  const active = document.activeElement;
  const key = active?.dataset?.focus;
  const sel = key && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  $app.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
  for (const d of $app.querySelectorAll('details[data-key]')) if (openDetails.has(d.dataset.key)) d.open = true;
  if (key) {
    const el = $app.querySelector(`[data-focus="${key}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      if (sel) try { el.setSelectionRange(...sel); } catch {}
    }
  }
}

function fmtDate(ms) {
  return new Date(ms).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtNum(x, d) {
  if (x === null || x === undefined) return '—';
  let s = Number(x.toFixed(d)).toString();
  if (s === '-0') s = '0';
  return s.replace('-', '−');
}
const fmtPct = (x) => (x === null ? '—' : `${fmtNum(x, 1)}%`);
const fmtSigned = (e) => (e === 0 ? '0' : e > 0 ? `＋${e}` : `−${-e}`);

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function errorBox(err) {
  return err ? h('p', { class: 'err', role: 'alert' }, err) : null;
}

// ---------- ルーティング ----------

function go(path) {
  history.pushState(null, '', withBase(path));
  route();
}
window.addEventListener('popstate', route);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-nav]');
  if (a) { e.preventDefault(); go(a.getAttribute('href').slice(BASE.length) || '/'); }
});

let G = null; // 現在のゲーム画面の状態

function route() {
  stopPolling();
  G = null;
  const p = location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) || '/' : location.pathname;
  const m = p.match(/^\/join\/([A-Za-z0-9_-]+)$/);
  if (m) return openInvite(m[1]);
  return showTop();
}

// ---------- トップ ----------

async function showTop() {
  const form = { nickname: '', role: null, err: null, sending: false };
  let rooms = [];
  const draw = () => {
    mount(
      h('h1', {}, 'レモンスコア'),
      h('p', { class: 'muted' }, 'メロンソーダに入ったレモンポーションの数を当てるゲームを、みんなのスマートフォンで記録・集計します。'),
      h('section', { class: 'card' },
        h('h2', {}, '新しいゲーム'),
        h('p', { class: 'small muted' }, '作った人が進行役になります。進行役は飲む人でも入れる人でもかまいません。'),
        nicknameField(form, draw),
        roleChoice(form, draw, false),
        errorBox(form.err),
        h('button', {
          class: 'primary block', disabled: form.sending,
          onclick: async () => {
            if (!form.role) { form.err = '役割を選んでください'; return draw(); }
            form.sending = true; form.err = null; draw();
            const r = await api('POST', '/api/rooms', { nickname: form.nickname, role: form.role });
            form.sending = false;
            if (!r.ok) { form.err = r.error.message; return draw(); }
            go(`/join/${r.data.invite_token}`);
          },
        }, form.sending ? '作成中…' : 'ゲームを作る'),
      ),
      rooms.length ? h('section', { class: 'card' },
        h('h2', {}, 'この端末で参加したゲーム'),
        h('ul', { class: 'plain' }, rooms.map((r) => h('li', {},
          h('div', { class: 'grow' },
            h('div', {}, `${fmtDate(r.created_at)}（${r.nickname}）`),
            h('div', { class: 'small muted' }, `${stateLabel(r.state)}・保存期限 ${fmtDate(r.expires_at)}`)),
          h('a', { class: 'btn', href: `/join/${r.invite_token}`, 'data-nav': true }, r.state === 'FINISHED' ? '結果を開く' : '続ける'),
        ))),
      ) : null,
    );
  };
  draw();
  const r = await api('GET', '/api/my-rooms');
  if (r.ok) { rooms = r.data.rooms; draw(); }
}

function stateLabel(s) {
  return { LOBBY: '参加受付中', PLAYING: '進行中', PAUSED: '一時停止中', FINISHED: '終了' }[s] || s;
}

function nicknameField(form, draw) {
  return [
    h('label', { for: 'nick' }, 'ニックネーム（1〜20文字）'),
    h('input', {
      id: 'nick', type: 'text', maxlength: '40', autocomplete: 'nickname', 'data-focus': 'nick', value: form.nickname,
      oninput: (e) => { form.nickname = e.target.value; },
    }),
  ];
}

function roleChoice(form, draw, aTaken) {
  const btn = (role) => h('button', {
    type: 'button', 'aria-pressed': String(form.role === role), disabled: role === 'A' && aTaken,
    onclick: () => { form.role = role; form.err = null; draw(); },
  }, h('span', {}, h('strong', {}, ROLE_LABEL[role]), h('br'), h('span', { class: 'small' }, ROLE_HELP[role])));
  return [
    h('label', {}, '役割'),
    h('div', { class: 'choice' }, btn('A'), btn('B')),
    aTaken ? h('p', { class: 'small muted' }, '飲む人は参加済みです。入れる人として参加してください。') : null,
  ];
}

// ---------- 招待URL ----------

async function openInvite(token) {
  mount(h('p', { class: 'muted center' }, '読み込み中…'));
  const r = await api('POST', '/api/invite', { token });
  if (!r.ok) {
    return mount(h('div', { class: 'card alert' },
      h('p', {}, r.error.message),
      h('a', { class: 'btn', href: '/', 'data-nav': true }, 'トップへ')));
  }
  const info = r.data;
  if (info.me && info.me.status !== 'REJECTED') return startGame(token, info.room_id);
  if (info.waiting_recovery) return showRecoveryWaiting(token, info.room_id, null);
  const names = await api('GET', `/api/rooms/${info.room_id}/recovery/names`);
  showJoin(token, info, names.ok ? names.data.members : []);
}

/** 参加済みの人の名前ボタン。タップするとそのまま「戻る」申請になる */
function nameButtons(token, roomId, members, state) {
  return h('div', { class: 'stack' },
    members.map((m) => h('button', {
      class: 'block', type: 'button', disabled: state.sending,
      onclick: async () => {
        state.sending = true; state.err = null; state.draw();
        const res = await api('POST', `/api/rooms/${roomId}/recovery`, { member_id: m.id });
        state.sending = false;
        if (!res.ok) {
          if (res.error.code === 'ALREADY_AUTHENTICATED') return startGame(token, roomId);
          state.err = res.error.message; return state.draw();
        }
        showRecoveryWaiting(token, roomId, res.data);
      },
    }, m.nickname)),
    errorBox(state.err),
  );
}

function showJoin(token, info, members) {
  const form = { nickname: '', role: info.a_taken ? 'B' : null, err: null, sending: false };
  const back = { sending: false, err: null };
  const draw = () => {
    const nodes = [];
    if (!info.joinable) {
      // 開始後・終了後は「戻る」だけ
      nodes.push(h('h1', {}, 'ゲームに戻る'), h('section', { class: 'card' },
        h('p', {}, '自分の名前をタップしてください。'),
        members.length ? nameButtons(token, info.room_id, members, back) : h('p', { class: 'muted' }, '参加者がいません。'),
        h('p', { class: 'small muted' }, info.state === 'FINISHED' ? 'このゲームは終了しています。参加していた人は結果を見られます。' : 'このゲームは始まっているため、新しく参加することはできません。'),
      ));
      return mount(...nodes);
    }
    nodes.push(h('h1', {}, 'ゲームに参加'));
    if (info.me?.status === 'REJECTED') nodes.push(h('div', { class: 'card notice' }, h('p', {}, `「${info.me.nickname}」での参加は承認されませんでした。名前を変えてもう一度申請できます。`)));
    nodes.push(h('section', { class: 'card' },
      nicknameField(form, draw),
      roleChoice(form, draw, info.a_taken),
      errorBox(form.err),
      h('button', {
        class: 'primary block', disabled: form.sending,
        onclick: async () => {
          if (!form.role) { form.err = '役割を選んでください'; return draw(); }
          form.sending = true; form.err = null; draw();
          const res = await api('POST', `/api/rooms/${info.room_id}/join`, { nickname: form.nickname, role: form.role });
          form.sending = false;
          if (!res.ok) {
            form.err = res.error.message;
            if (res.error.code === 'A_TAKEN') { info.a_taken = true; form.role = 'B'; }
            return draw();
          }
          startGame(token, info.room_id);
        },
      }, form.sending ? '送信中…' : '参加を申請する'),
      h('p', { class: 'small muted' }, '進行役が承認すると参加できます。'),
    ));
    if (members.length) {
      nodes.push(h('details', { class: 'card', 'data-key': 'back' },
        h('summary', {}, 'もう参加している人はこちら'),
        h('p', { class: 'small muted' }, '画面を閉じた・別のブラウザで開いた などのときは、自分の名前をタップしてください。'),
        nameButtons(token, info.room_id, members, back)));
    }
    mount(...nodes);
  };
  back.draw = draw;
  draw();
}

function showRecoveryWaiting(token, roomId, req) {
  let info = req;
  let message = null;
  const draw = () => mount(
    h('h1', {}, 'ゲームに戻る'),
    h('section', { class: 'card hero' },
      info ? h('p', {}, h('strong', {}, `「${info.nickname}」`), 'として戻ります') : null,
      message
        ? [h('p', { class: 'err' }, message), h('button', { class: 'primary block', onclick: () => openInvite(token) }, 'もう一度やる')]
        : [
          h('p', {}, 'そばにいる参加者の誰かに、その人の画面に出る「許可」を押してもらってください。'),
          h('p', { class: 'muted small' }, '許可されると自動でゲームに戻ります。'),
          h('button', { class: 'ghost block', onclick: () => { stopPolling(); openInvite(token); } }, '名前を選び直す'),
        ],
    ),
  );
  draw();
  const tick = async () => {
    const r = await api('GET', `/api/rooms/${roomId}/recovery/status`);
    if (!r.ok) {
      if (r.network) return;
      message = r.error.message; stopPolling(); return draw();
    }
    info = { ...(info || {}), ...r.data };
    if (r.data.status === 'APPROVED') { stopPolling(); return startGame(token, roomId); }
    if (r.data.status === 'REJECTED') { message = '許可されませんでした。'; stopPolling(); }
    if (r.data.status === 'EXPIRED') { message = '時間切れになりました（10分）。'; stopPolling(); }
    draw();
  };
  startPolling(tick);
}

// ---------- ポーリング ----------

let pollTimer = null;
let pollFn = null;
function startPolling(fn) {
  stopPolling();
  pollFn = fn;
  fn();
  pollTimer = setInterval(() => { if (!document.hidden) fn(); }, POLL_MS);
}
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
  pollFn = null;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && pollFn) pollFn(); });
window.addEventListener('online', () => pollFn && pollFn());

// ---------- ゲーム画面 ----------

function startGame(token, roomId) {
  G = {
    token, roomId, st: null, version: null,
    draft: null, // { key, value, confirming, requestId, sending, err }
    flash: null, panel: null, mine: null, menuErr: null,
    voidSel: null, voidReason: '', finishOpenRound: null, result: null, anon: false, copyMsg: null, showText: false, deleting: false,
  };
  startPolling(refresh);
}

async function refresh() {
  if (!G) return;
  const g = G;
  const r = await api('GET', `/api/rooms/${g.roomId}/state`);
  if (G !== g) return;
  if (!r.ok) {
    if (r.network) return;
    stopPolling();
    if (r.status === 401) return openInvite(g.token);
    return mount(h('div', { class: 'card alert' }, h('p', {}, r.error.message), h('a', { class: 'btn', href: '/', 'data-nav': true }, 'トップへ')));
  }
  const st = r.data;
  let changed = !g.st || st.room.version !== g.st.room.version || st.me.status !== g.st.me.status;
  g.st = st;
  if (st.room.state === 'FINISHED' && !g.result) {
    const res = await api('GET', `/api/rooms/${g.roomId}/result`);
    if (G !== g) return;
    if (res.ok) { g.result = res.data; stopPolling(); changed = true; }
  }
  if (changed) render();
}

function render() {
  const g = G;
  const st = g.st;
  if (st.me.status === 'PENDING') {
    return mount(h('h1', {}, '承認待ち'), h('section', { class: 'card hero' },
      h('p', {}, `「${st.me.nickname}」・${ROLE_LABEL[st.me.role]}で参加を申請しました。`),
      h('p', { class: 'muted' }, '進行役が承認するまでお待ちください。承認されると自動で切り替わります。')));
  }
  if (st.me.status === 'REJECTED') {
    stopPolling();
    return openInvite(g.token);
  }
  if (st.room.state === 'FINISHED') return g.result ? renderResult() : mount(h('p', { class: 'muted center' }, '結果を読み込み中…'));
  syncDraft();
  const nodes = [recoveryApprovals()];
  if (st.room.state === 'LOBBY') nodes.push(...renderLobby());
  else nodes.push(...renderPlaying());
  mount(...nodes);
}

function recoveryApprovals() {
  const reqs = G.st.recovery_requests;
  if (!reqs.length) return null;
  return h('section', { class: 'card notice' },
    reqs.map((q) => h('div', { class: 'stack' },
      h('p', {}, h('strong', {}, `${q.nickname}さん`), 'が別の画面から戻ろうとしています。'),
      h('p', { class: 'small' }, '本人がそばで操作しているなら「許可」を押してください。（誰が押してもOK）'),
      h('div', { class: 'row' },
        h('button', { class: 'primary grow', onclick: () => decideRecovery(q.id, true) }, '許可'),
        h('button', { class: 'grow', onclick: () => decideRecovery(q.id, false) }, '拒否')),
    )),
  );
}

async function decideRecovery(id, approve) {
  const r = await api('POST', `/api/rooms/${G.roomId}/recovery/decide`, { request_id: id, approve });
  if (!r.ok) alert(r.error.message);
  refresh();
}

async function hostAction(path, body = {}) {
  G.menuErr = null;
  const r = await api('POST', `/api/rooms/${G.roomId}/${path}`, body);
  if (!r.ok) { G.menuErr = r.error.message; render(); }
  await refresh();
  return r;
}

// ---------- ロビー ----------

function renderLobby() {
  const g = G;
  const st = g.st;
  const isHost = st.me.is_host;
  const a = st.members.find((m) => m.role === 'A');
  const nodes = [h('h1', {}, '参加受付中')];

  nodes.push(h('section', { class: 'card' },
    h('p', {}, `あなた：${st.me.nickname}・${ROLE_LABEL[st.me.role]}${isHost ? '・進行役' : ''}`),
    h('h3', {}, '飲む人'),
    h('p', {}, a ? a.nickname : h('span', { class: 'muted' }, 'まだいません')),
    h('h3', {}, '入れる人の順番'),
    st.b_order.length ? h('ol', {}, st.b_order.map((b, i) => h('li', {},
      h('div', { class: 'row' },
        h('span', { class: 'grow' }, b.nickname),
        isHost ? h('button', { 'aria-label': `${b.nickname}を上へ`, disabled: i === 0, onclick: () => moveB(i, -1) }, '↑') : null,
        isHost ? h('button', { 'aria-label': `${b.nickname}を下へ`, disabled: i === st.b_order.length - 1, onclick: () => moveB(i, 1) }, '↓') : null,
      )))) : h('p', { class: 'muted' }, 'まだいません'),
  ));

  if (isHost) {
    if (st.pending_members.length) {
      nodes.push(h('section', { class: 'card notice' },
        h('h2', {}, '参加の承認'),
        h('ul', { class: 'plain' }, st.pending_members.map((p) => h('li', {},
          h('span', { class: 'grow' }, p.nickname, ' ', h('span', { class: `tag ${p.role === 'A' ? 'a' : ''}` }, ROLE_LABEL[p.role])),
          h('button', { class: 'primary', disabled: p.role === 'A' && !!a, onclick: () => hostAction('members/approve', { member_id: p.id }) }, '承認'),
          h('button', { onclick: () => hostAction('members/reject', { member_id: p.id }) }, '拒否'),
        ))),
        a && st.pending_members.some((p) => p.role === 'A') ? h('p', { class: 'small muted' }, '飲む人は既に決まっているため、飲む人としての申請は承認できません。') : null,
      ));
    }
    const others = st.members.filter((m) => !m.is_host);
    if (others.length) {
      nodes.push(h('details', { class: 'card', 'data-key': 'remove' }, h('summary', {}, '参加の取り消し'),
        h('ul', { class: 'plain' }, others.map((m) => h('li', {},
          h('span', { class: 'grow' }, m.nickname, ' ', h('span', { class: 'tag' }, ROLE_LABEL[m.role])),
          h('button', { onclick: () => { if (confirm(`${m.nickname}さんの参加を取り消しますか？`)) hostAction('members/remove', { member_id: m.id }); } }, '取消'),
        )))));
    }
    const canStart = !!a && st.b_order.length > 0;
    nodes.push(h('section', { class: 'card' },
      errorBox(g.menuErr),
      h('button', {
        class: 'primary block', disabled: !canStart,
        onclick: () => { if (confirm('この順番で開始しますか？開始後は新しい参加と役割の変更はできません。')) hostAction('start', { request_id: rid() }); },
      }, 'ゲームを開始'),
      canStart ? null : h('p', { class: 'small muted' }, '飲む人が1人、入れる人が1人以上そろうと開始できます。'),
    ));
  } else {
    nodes.push(h('p', { class: 'muted center' }, '進行役が開始するのを待っています。'));
  }

  nodes.push(inviteCard());
  return nodes;
}

async function moveB(i, d) {
  const order = G.st.b_order.map((b) => b.id);
  [order[i], order[i + d]] = [order[i + d], order[i]];
  await hostAction('order', { order });
}

function inviteCard() {
  const url = G.st.room.invite_url;
  return h('details', { class: 'card', 'data-key': 'invite', open: G.st.room.state === 'LOBBY' ? true : null },
    h('summary', {}, '招待URL・QRコード'),
    h('p', { class: 'small muted' }, 'LINEなどに貼って送ってください。押すと普段のブラウザで開きます。参加済みの人が戻るときも同じURLを使えます。'),
    h('div', { class: 'url' }, url),
    h('div', { class: 'row' },
      h('button', { class: 'grow', onclick: async (e) => { e.target.textContent = (await copyText(url)) ? 'コピーしました' : 'コピーできませんでした。上のURLを長押ししてコピーしてください'; } }, 'URLをコピー')),
    h('img', { class: 'qr', src: `/api/rooms/${G.roomId}/qr.svg`, alt: '招待URLのQRコード' }),
  );
}

// ---------- 進行中 ----------

/** 下書きは現在の杯・入力種別にだけ結び付ける。杯が変わったら捨てる。 */
function currentInputKey() {
  const st = G.st;
  const c = st.current;
  if (!c) return null; // 一時停止中も下書きは保持する
  if (c.phase === 'WAIT_ACTUAL' && c.b_member_id === st.me.id) return `actual:${c.number}`;
  if (c.phase === 'WAIT_GUESS' && st.me.id === st.a_member_id) return `guess:${c.round_id}`;
  return null;
}

function syncDraft() {
  const key = currentInputKey();
  const d = G.draft;
  if (d && d.key !== key) {
    // 送信済みで杯が進んだなら、サーバー状態で記録済みと判断できる
    if (d.key.startsWith('guess:')) {
      const rid_ = d.key.slice(6);
      const r = G.st.rounds.find((x) => x.id === rid_);
      if (r && r.status === 'COMPLETED' && d.requestId) G.flash = `第${r.number}杯の予想を記録しました`;
    }
    G.draft = null;
  }
  if (key && !G.draft) G.draft = { key, value: '', confirming: false, requestId: null, sending: false, err: null };
}

function renderPlaying() {
  const g = G;
  const st = g.st;
  const c = st.current;
  const isA = st.me.id === st.a_member_id;
  const nodes = [];

  if (st.room.state === 'PAUSED') nodes.push(h('div', { class: 'card alert' }, h('p', {}, '一時停止中です。進行役が再開するまで入力できません。')));

  nodes.push(h('section', { class: 'card hero' },
    h('div', { class: 'turn' }, `第${c.number}杯`),
    h('div', {}, `担当：${c.b_nickname}`),
    h('div', { class: 'status-pill' }, c.phase === 'WAIT_ACTUAL' ? '実投入待ち' : '予想待ち'),
    h('p', { class: 'small muted' }, `記録済み：${st.completed_count}杯`),
  ));

  if (g.flash) nodes.push(h('p', { class: 'okmsg center', role: 'status' }, g.flash));

  const key = st.room.state === 'PLAYING' ? currentInputKey() : null;
  if (key?.startsWith('actual:')) nodes.push(countInput({
    title: `第${c.number}杯・あなたの当番です`, label: '実際に入れた個数', help: '入れたら数を入力して確定してください。飲む人には終了まで見えません。',
    confirmLabel: '実際に入れた個数', confirmNote: 'これで確定しますか？飲む人が予想を確定するまでは「自分が入れた個数を見る」から訂正できます。', unit: '個',
    send: (d) => api('POST', `/api/rooms/${g.roomId}/actual`, { request_id: d.requestId, count: Number(d.value) }),
  }));
  else if (key?.startsWith('guess:')) nodes.push(countInput({
    title: `第${c.number}杯`, label: '何個入っていると思う？', help: '飲んでから、予想した数を入力して確定してください。',
    confirmLabel: 'あなたの予想', confirmNote: 'これで確定しますか？確定後は変更できません。正解は終了後に公開されます。', unit: '個',
    send: (d) => api('POST', `/api/rooms/${g.roomId}/guess`, { request_id: d.requestId, round_id: c.round_id, version: c.round_version, count: Number(d.value) }),
  }));
  else nodes.push(waitingCard());

  if (st.me.role === 'B' || isA) nodes.push(mineCard());
  if (st.me.is_host) nodes.push(hostMenu());
  nodes.push(inviteCard());
  return nodes;
}

function waitingCard() {
  const st = G.st;
  const c = st.current;
  const isA = st.me.id === st.a_member_id;
  let msg;
  if (st.room.state === 'PAUSED' && (c.phase === 'WAIT_ACTUAL' ? c.b_member_id === st.me.id : isA)) {
    msg = '一時停止中です。再開後に入力できます。';
  } else if (c.phase === 'WAIT_ACTUAL') {
    msg = isA ? `${c.b_nickname}さんが用意しています。届くまで待ってください。` : `${c.b_nickname}さんの入力を待っています。`;
  } else if (c.b_member_id === st.me.id) {
    msg = '実投入数を記録しました。飲む人の予想を待っています。';
  } else {
    msg = isA ? '予想を入力できる状態です。' : '飲む人の予想を待っています。';
  }
  return h('section', { class: 'card info' }, h('p', {}, msg));
}

function countInput({ title, label, help, confirmLabel, confirmNote, unit, send }) {
  const g = G;
  const d = g.draft;
  const max = 999;
  const valid = /^\d+$/.test(d.value) && Number(d.value) <= max;
  const set = (v) => { d.value = v; d.err = null; d.confirming = false; d.requestId = null; render(); };

  if (d.confirming) {
    return h('section', { class: 'card' },
      h('h2', {}, title),
      h('p', {}, `${confirmLabel}：`),
      h('div', { class: 'bigval' }, `${Number(d.value)}${unit}`),
      h('p', { class: 'small muted' }, confirmNote),
      errorBox(d.err),
      h('div', { class: 'row' },
        h('button', { class: 'grow', disabled: d.sending, onclick: () => { d.confirming = false; d.err = null; d.requestId = null; render(); } }, '戻る'),
        h('button', {
          class: 'primary grow', disabled: d.sending,
          onclick: async () => {
            if (d.sending) return;
            d.sending = true; d.err = null;
            d.requestId ??= rid(); // 同じ内容の再送は同じIDで（二重記録防止）
            render();
            const r = await send(d);
            d.sending = false;
            if (r.ok) {
              if (d.key.startsWith('guess:')) G.flash = `第${G.st.current.number}杯の予想を記録しました`;
              else G.flash = null;
            } else if (r.network) {
              d.err = '通信できませんでした。記録されたか確認しています。もう一度「確定する」を押しても二重に記録されません。';
            } else {
              d.err = r.error.message;
              d.requestId = null;
              if (r.error.code === 'ROUND_CHANGED') d.confirming = false;
            }
            render();
            await refresh();
          },
        }, d.sending ? '送信中…' : '確定する'),
      ),
    );
  }
  const n = valid ? Number(d.value) : null;
  return h('section', { class: 'card' },
    h('h2', {}, title),
    h('label', { for: 'count' }, label),
    h('div', { class: 'counter' },
      h('button', { type: 'button', 'aria-label': '1減らす', onclick: () => set(n === null ? '0' : String(Math.max(0, n - 1))) }, '−'),
      h('input', {
        id: 'count', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'off', 'data-focus': 'count', value: d.value, placeholder: '?',
        oninput: (e) => { d.value = e.target.value.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/\s/g, ''); d.err = null; },
        onkeydown: (e) => { if (e.key === 'Enter') e.target.closest('section').querySelector('button.primary').click(); },
      }),
      h('button', { type: 'button', 'aria-label': '1増やす', onclick: () => set(n === null ? '1' : String(Math.min(max, n + 1))) }, '＋'),
    ),
    h('p', { class: 'small muted' }, help),
    errorBox(d.err),
    h('button', {
      class: 'primary block',
      onclick: () => {
        if (!/^\d+$/.test(d.value) || Number(d.value) > max) { d.err = `0〜${max}の整数を入力してください`; return render(); }
        d.confirming = true; G.flash = null; render();
      },
    }, '確認へ'),
  );
}

function mineCard() {
  const g = G;
  const isB = g.st.me.role === 'B';
  const open = g.panel === 'mine';
  const section = h('section', { class: 'card' });
  section.append(h('button', {
    class: 'block',
    onclick: async () => {
      if (open) { g.panel = null; g.mine = null; return render(); }
      const r = await api('GET', `/api/rooms/${g.roomId}/mine`);
      if (!r.ok) return alert(r.error.message);
      g.mine = r.data; g.panel = 'mine'; render();
    },
  }, open ? '閉じる' : isB ? '自分が入れた個数を見る' : '自分の予想を見る'));
  if (open && g.mine) {
    section.append(h('p', { class: 'small muted' }, '周りの人に画面を見られないよう注意してください。'));
    if (!g.mine.rounds.length) section.append(h('p', { class: 'muted' }, 'まだ記録がありません。'));
    section.append(h('ul', { class: 'plain' }, g.mine.rounds.map((r) => h('li', {},
      h('span', { class: 'grow' }, `${r.number}杯目：${isB ? r.actual_count : r.guess_count}個`, r.status === 'VOID' ? '（無効）' : ''),
      isB && r.correctable ? h('button', { onclick: () => correctActual(r) }, '訂正') : null,
    ))));
  }
  return section;
}

async function correctActual(r) {
  const v = prompt(`${r.number}杯目の実投入数を訂正します。正しい個数を入力してください（飲む人の予想確定前のみ）`, '');
  if (v === null) return;
  const s = v.trim().replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  if (!/^\d+$/.test(s)) return alert('0以上の整数を入力してください');
  const res = await api('POST', `/api/rooms/${G.roomId}/actual/correct`, { request_id: rid(), round_id: r.id, version: r.version, count: Number(s) });
  if (!res.ok) alert(res.error.message);
  G.panel = null; G.mine = null;
  await refresh();
  render();
}

function hostMenu() {
  const g = G;
  const st = g.st;
  const c = st.current;
  const paused = st.room.state === 'PAUSED';
  const voidable = st.rounds.filter((r) => r.status !== 'VOID');
  const sec = h('details', { class: 'card', 'data-key': 'hostmenu', open: g.panel === 'void' || g.panel === 'finish' || !!g.menuErr || null },
    h('summary', {}, '進行メニュー（進行役）'),
    errorBox(g.menuErr),
    h('div', { class: 'menu' },
      paused
        ? h('button', { onclick: () => hostAction('resume', { request_id: rid() }) }, '▶ 再開する')
        : h('button', { onclick: () => hostAction('pause', { request_id: rid() }) }, '⏸ 一時停止'),
      c.phase === 'WAIT_ACTUAL' && !paused
        ? h('button', { onclick: () => { if (confirm(`${c.b_nickname}さんの当番をとばして次の人にしますか？`)) hostAction('skip', { request_id: rid() }); } }, `⏭ ${c.b_nickname}さんの当番をスキップ`)
        : null,
      h('button', { disabled: !voidable.length, onclick: () => { g.panel = g.panel === 'void' ? null : 'void'; g.voidSel = null; g.voidReason = ''; render(); } }, '✕ 杯を無効にする'),
      h('button', { class: 'danger', onclick: () => { g.panel = 'finish'; g.finishOpenRound = null; render(); } }, 'ゲームを終了して結果を見る'),
    ),
  );
  if (g.panel === 'void') {
    sec.append(h('div', { class: 'card' },
      h('h3', {}, '無効にする杯'),
      h('p', { class: 'small muted' }, '無効にした杯は集計から除外され、理由とともに結果の別枠に表示されます。数値はこの画面には表示されません。'),
      h('div', { class: 'stack' }, voidable.map((r) => h('button', {
        class: 'block', 'aria-pressed': String(g.voidSel === r.id), onclick: () => { g.voidSel = r.id; render(); },
      }, `${g.voidSel === r.id ? '✓ ' : ''}${r.number}杯目（${r.b_nickname}）${r.status === 'WAIT_GUESS' ? '・予想待ち' : ''}`))),
      h('label', { for: 'reason' }, '理由（必須）'),
      h('input', { id: 'reason', type: 'text', maxlength: '100', 'data-focus': 'reason', value: g.voidReason, oninput: (e) => { g.voidReason = e.target.value; } }),
      h('button', {
        class: 'primary block', disabled: !g.voidSel,
        onclick: async () => {
          if (!g.voidReason.trim()) { g.menuErr = '理由を入力してください'; return render(); }
          const r = await hostAction('void', { request_id: rid(), round_id: g.voidSel, reason: g.voidReason });
          if (r.ok) { g.panel = null; render(); }
        },
      }, '無効にする'),
    ));
  }
  if (g.panel === 'finish') {
    const openRound = c.phase === 'WAIT_GUESS' ? c : null;
    sec.append(h('div', { class: 'card alert' },
      h('h3', {}, 'ゲームを終了しますか？'),
      h('p', {}, '終了すると全員に正解が公開されます。終了後は記録の追加・修正・再開はできません。'),
      openRound ? h('p', {}, `第${openRound.number}杯は飲む人の予想がまだです。「予想を待つ」か「この杯を無効にして終了」を選んでください。`) : null,
      c.phase === 'WAIT_ACTUAL' ? h('p', { class: 'small muted' }, `準備中の第${c.number}杯は記録されていないため、結果には含まれません。`) : null,
      h('div', { class: 'stack' },
        openRound
          ? h('button', { class: 'danger block', onclick: () => doFinish(true) }, 'この杯を無効にして終了')
          : h('button', { class: 'danger block', onclick: () => doFinish(false) }, '終了して結果を公開'),
        h('button', { class: 'block', onclick: () => { g.panel = null; render(); } }, openRound ? '予想を待つ' : 'やめる'),
      ),
    ));
  }
  return sec;
}

async function doFinish(voidOpen) {
  const r = await hostAction('finish', { request_id: rid(), void_open: voidOpen });
  if (r.ok) G.panel = null;
  else if (r.error.code === 'OPEN_ROUND') { G.menuErr = r.error.message; }
  render();
}

// ---------- リザルト ----------

function renderResult() {
  const g = G;
  const res = g.result;
  const s = res.stats;
  const valid = res.rounds.filter((r) => r.status === 'COMPLETED');
  const voids = res.rounds.filter((r) => r.status === 'VOID');
  const text = g.anon ? res.text_anonymous : res.text;
  const stat = (k, v, wide) => h('div', { class: `stat${wide ? ' wide' : ''}` }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
  const biasText = s.bias === null ? '—' : `${s.bias === 0 ? '0' : (s.bias > 0 ? '＋' : '') + fmtNum(s.bias, 2)}個${s.bias < 0 ? '（少なめ）' : s.bias > 0 ? '（多め）' : ''}`;
  const cond = res.condition;

  mount(
    h('h1', {}, '結果'),
    h('p', { class: 'muted small' }, `${fmtDate(res.room.started_at)} ・ 飲む人：${res.a_nickname}`),
    // 一番上は短い要約だけにして、すぐ各杯が見えるようにする
    // 一番上：正答率・合計レモン・調子の目安をひとまとまりで
    h('section', { class: `card summary${cond ? ` lv${cond.level}` : ''}` },
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('div', { class: 'k' }, '🎯 正答率'), h('div', { class: 'v' }, fmtPct(s.accuracy)), h('div', { class: 'k' }, `${s.valid_count}杯中 ${s.correct_count}杯正解`)),
        h('div', { class: 'stat' }, h('div', { class: 'k' }, '🍋 合計レモン'), h('div', { class: 'v' }, `${res.total_lemons}個`), h('div', { class: 'k' }, '飲んだ杯の合計')),
      ),
      cond ? h('div', { class: 'condition' },
        h('div', { class: 'k small' }, '調子の目安'),
        h('div', { class: 'cond-text' }, `${cond.emoji} ${cond.text}`),
        cond.trend ? h('p', {}, cond.trend) : null,
      ) : null,
    ),

    // 1. 各杯
    h('h2', {}, '各杯の結果'),
    valid.length ? valid.map((r) => {
      const hit = r.error === 0;
      return h('div', { class: `round ${hit ? 'hit' : 'miss'}` },
        h('div', { class: 'head' }, h('span', {}, `${r.number}杯目［${r.b_nickname}］`), h('span', { class: 'verdict' }, hit ? '🎯 正解' : `❌ はずれ ${fmtSigned(r.error)}`)),
        h('div', {}, `実投入 ${r.actual_count}個 → 予想 ${r.guess_count}個`),
        h('div', { class: 'small muted' }, r.condition),
      );
    }) : h('p', { class: 'muted' }, '有効な杯はありません。'),
    voids.length ? [h('h3', {}, '無効にした杯'), voids.map((r) => h('div', { class: 'round void' },
      h('div', { class: 'head' }, h('span', {}, `${r.number}杯目［${r.b_nickname}］`), h('span', { class: 'verdict' }, '無効')),
      h('div', {}, `実投入 ${r.actual_count ?? '—'}個 → 予想 ${r.guess_count ?? '—'}個`),
      h('div', { class: 'small' }, `理由：${r.void_reason}`),
    ))] : null,

    // 2. 集計
    h('h2', {}, '集計'),
    h('section', { class: 'card' },
      h('div', { class: 'stats' },
        stat('正答率', `${fmtPct(s.accuracy)}`, true),
        stat('有効 / 正解', `${s.valid_count}杯 / ${s.correct_count}杯`),
        stat('平均のズレ', s.mean_abs_error === null ? '—' : `${fmtNum(s.mean_abs_error, 2)}個`),
        stat('予想の偏り', biasText),
        stat('最大のズレ', s.max_abs_error === null ? '—' : `${s.max_abs_error}個`),
        stat('±1以内', fmtPct(s.within_one_rate), true),
      ),
    ),

    // 3. コピー
    h('h2', {}, '結果をコピー'),
    h('section', { class: 'card' },
      h('div', { class: 'row' },
        h('label', { class: 'grow small' },
          h('input', { type: 'checkbox', checked: g.anon || null, onchange: (e) => { g.anon = e.target.checked; g.copyMsg = null; renderResult(); } }),
          ' ニックネームを省く（匿名）')),
      h('button', {
        class: 'primary block',
        onclick: async () => {
          const ok = await copyText(text);
          g.copyMsg = ok ? 'コピーしました。LINEなどに貼り付けてください。' : null;
          g.showText = !ok;
          renderResult();
        },
      }, '結果をコピー'),
      g.copyMsg ? h('p', { class: 'okmsg' }, g.copyMsg) : null,
      h('details', { 'data-key': 'resulttext', open: g.showText || null },
        h('summary', {}, g.showText ? 'コピーできなかったため、下の文章を長押しして選択してください' : '文章を表示'),
        h('textarea', { readonly: true, 'aria-label': '結果の文章', onfocus: (e) => e.target.select() }, text)),
    ),

    // 4. 入れた人ごと
    res.by_b.length ? [h('h2', {}, '入れた人ごとの結果'), h('section', { class: 'card' },
      h('ul', { class: 'plain' }, res.by_b.map((b) => h('li', {}, h('div', {},
        h('div', { class: 'grow' }, h('strong', {}, b.nickname)),
        h('div', { class: 'small' }, `有効${b.valid_count}杯・正解${b.correct_count}杯（${fmtPct(b.accuracy)}）・平均のズレ ${b.mean_abs_error === null ? '—' : fmtNum(b.mean_abs_error, 2) + '個'}`),
      )))),
      h('p', { class: 'small muted' }, '入れた個数や杯数が違うため、入れた人の難しさの順位ではありません。'),
    )] : null,

    // 5. 保存・削除
    h('section', { class: 'card' },
      h('a', { class: 'btn block', href: `/api/rooms/${g.roomId}/export.json`, download: true }, 'JSONで保存'),
      h('p', { class: 'small muted' }, `この結果は ${fmtDate(res.room.expires_at)} まで保存され、その後自動で削除されます。`),
    ),
    res.me.is_host ? h('details', { class: 'card', 'data-key': 'delete' },
      h('summary', {}, 'このゲームを削除（進行役）'),
      h('p', {}, '削除すると、全参加者がこの結果を見られなくなります。元に戻せません。'),
      h('button', {
        class: 'danger block', disabled: g.deleting,
        onclick: async () => {
          if (!confirm('本当に削除しますか？')) return;
          g.deleting = true;
          const r = await api('POST', `/api/rooms/${g.roomId}/delete`, { confirm: true });
          if (!r.ok) { g.deleting = false; return alert(r.error.message); }
          go('/');
        },
      }, '削除する'),
    ) : null,
    h('a', { class: 'btn block', href: '/', 'data-nav': true }, '新しいゲームを作る'),
  );
}

route();
