// ゲームの権限・状態遷移・秘匿をすべてここで判定する。
// クライアントから送られた role / member_id は信用せず、毎回セッションから参加者を引き直す。
// レスポンスはDB行をそのまま返さず、役割ごとに明示的に組み立てる。

import { tx } from './db.js';
import { AppError, newId, newToken, hashToken, normalizeNickname, parseCount, parseRole, parseReason } from './util.js';
import { computeStats, computeStatsByB, formatResultText } from './stats.js';

export const FATIGUE_LABELS = ['疲れていない', '少し疲れている', 'そこそこ疲れている', 'かなり疲れている', 'とても疲れている'];
const SCHEMA_VERSION = 1;

const err = (status, code, msg) => new AppError(status, code, msg);
const NOT_FOUND = () => err(404, 'NOT_FOUND', 'ゲームが見つかりません。期限切れか削除された可能性があります');
const FORBIDDEN = (msg = 'この操作はできません') => err(403, 'FORBIDDEN', msg);

export class Game {
  constructor(db, cfg, now = () => Date.now()) {
    this.db = db;
    this.cfg = cfg;
    this.now = now;
    this.st = {};
  }

  q(sql) {
    return (this.st[sql] ??= this.db.prepare(sql));
  }

  // ---------- 基本の読み出し ----------

  _room(roomId) {
    const room = this.q('SELECT * FROM rooms WHERE id = ?').get(String(roomId ?? ''));
    if (!room) return null;
    if (room.expires_at <= this.now()) return null; // 期限切れは存在しない扱い（削除は定期処理）
    room.b_order = JSON.parse(room.b_order);
    return room;
  }

  roomByInvite(token) {
    const r = this.q('SELECT id FROM rooms WHERE invite_token = ?').get(String(token ?? ''));
    return r ? this._room(r.id) : null;
  }

  _member(id) {
    return this.q('SELECT * FROM members WHERE id = ?').get(String(id ?? ''));
  }

  _members(roomId) {
    return this.q('SELECT * FROM members WHERE room_id = ? ORDER BY joined_at, rowid').all(roomId);
  }

  _rounds(roomId) {
    return this.q('SELECT * FROM rounds WHERE room_id = ? ORDER BY number').all(roomId);
  }

  _openRound(roomId) {
    return this.q("SELECT * FROM rounds WHERE room_id = ? AND status = 'WAIT_GUESS'").get(roomId);
  }

  /** セッショントークンから参加者を引く。無効なら null。 */
  _session(roomId, token) {
    if (!token) return null;
    const room = this._room(roomId);
    if (!room) return null;
    const s = this.q('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token));
    if (!s || s.room_id !== room.id) return null;
    const me = this._member(s.member_id);
    if (!me || me.room_id !== room.id || me.status === 'REMOVED' || me.auth_generation !== s.generation) return null;
    return { room, me };
  }

  _auth(roomId, token) {
    const a = this._session(roomId, token);
    if (!a) {
      if (!this._room(roomId)) throw NOT_FOUND();
      throw err(401, 'UNAUTHENTICATED', 'このブラウザはこのゲームの参加者として認証されていません');
    }
    return a;
  }

  _approved(roomId, token) {
    const a = this._auth(roomId, token);
    if (a.me.status !== 'APPROVED') throw FORBIDDEN('進行役の承認を待っています');
    return a;
  }

  _host(roomId, token) {
    const a = this._approved(roomId, token);
    if (!a.me.is_host) throw FORBIDDEN('進行役だけが操作できます');
    return a;
  }

  _issueSession(room, member) {
    const token = newToken();
    this.q('INSERT INTO sessions (token_hash, room_id, member_id, generation, created_at) VALUES (?,?,?,?,?)')
      .run(hashToken(token), room.id, member.id, member.auth_generation, this.now());
    return token;
  }

  /** 認証世代を上げて、旧セッションと同じ参加者への古い復帰申請を失効させる */
  _rotateAuth(member) {
    const gen = member.auth_generation + 1;
    this.q('UPDATE members SET auth_generation = ? WHERE id = ?').run(gen, member.id);
    this.q('DELETE FROM sessions WHERE member_id = ?').run(member.id);
    this.q("UPDATE recovery_requests SET status = 'EXPIRED' WHERE member_id = ? AND status IN ('PENDING','APPROVED')").run(member.id);
    member.auth_generation = gen;
    return gen;
  }

  _touch(room, { activity = false } = {}) {
    const now = this.now();
    let expires = room.expires_at;
    if (activity && (room.state === 'PLAYING' || room.state === 'PAUSED')) expires = now + this.cfg.activeTtlMs;
    this.q('UPDATE rooms SET version = version + 1, last_activity_at = CASE WHEN ? THEN ? ELSE last_activity_at END, expires_at = ? WHERE id = ?')
      .run(activity ? 1 : 0, now, expires, room.id);
  }

  _log(roomId, type, actor, target = null) {
    this.q('INSERT INTO events (room_id, type, actor_member_id, target, at) VALUES (?,?,?,?,?)').run(roomId, type, actor ?? null, target, this.now());
  }

  _saveOrder(room, order, extra = '') {
    this.q(`UPDATE rooms SET b_order = ?${extra} WHERE id = ?`).run(JSON.stringify(order), room.id);
  }

  /**
   * request_id による再送の識別。同じIDで同じ内容なら最初の結果を返す。別内容なら拒否。
   * 成功した結果だけを記録する（失敗はロールバックされるので再送で再判定される）。
   */
  _idempotent(me, room, op, requestId, body, fn) {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) {
      throw err(400, 'BAD_REQUEST_ID', 'request_id が不正です');
    }
    const bodyHash = hashToken(op + '\u0000' + JSON.stringify(body));
    const prev = this.q('SELECT * FROM idempotency WHERE member_id = ? AND request_id = ?').get(me.id, requestId);
    if (prev) {
      if (prev.body_hash !== bodyHash) throw err(409, 'REQUEST_ID_REUSED', '同じ送信IDで別の内容が送られました');
      return { replayed: true, ...JSON.parse(prev.response) };
    }
    const result = fn();
    this.q('INSERT INTO idempotency (member_id, request_id, room_id, op, body_hash, status, response, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(me.id, requestId, room.id, op, bodyHash, 200, JSON.stringify(result), this.now());
    return result;
  }

  // ---------- 作成・参加 ----------

  createRoom({ nickname, role }) {
    const { name, norm } = normalizeNickname(nickname);
    role = parseRole(role);
    return tx(this.db, () => {
      const now = this.now();
      const room = { id: newId(), invite_token: newToken() };
      const mid = newId();
      this.q(`INSERT INTO rooms (id, invite_token, state, host_member_id, a_member_id, b_order, created_at, last_activity_at, expires_at)
              VALUES (?,?,'LOBBY',?,?,?,?,?,?)`)
        .run(room.id, room.invite_token, mid, role === 'A' ? mid : null, JSON.stringify(role === 'B' ? [mid] : []), now, now, now + this.cfg.lobbyTtlMs);
      this.q("INSERT INTO members (id, room_id, nickname, nickname_norm, role, status, is_host, joined_at) VALUES (?,?,?,?,?,'APPROVED',1,?)")
        .run(mid, room.id, name, norm, role, now);
      this._log(room.id, 'ROOM_CREATED', mid);
      const token = this._issueSession(room, this._member(mid));
      return { roomId: room.id, inviteToken: room.invite_token, sessionToken: token };
    });
  }

  /** 招待URLを開いた人向けの最小限の情報。数値・役割・成績は含めない。 */
  inviteInfo(room, sessionToken, waitToken) {
    const a = this._session(room.id, sessionToken);
    const info = {
      room_id: room.id,
      state: room.state,
      joinable: room.state === 'LOBBY',
      a_taken: room.a_member_id !== null,
      me: a ? { status: a.me.status, nickname: a.me.nickname } : null,
      waiting_recovery: null,
    };
    if (!a && waitToken) {
      const req = this.q('SELECT * FROM recovery_requests WHERE wait_hash = ? AND room_id = ?').get(hashToken(waitToken), room.id);
      if (req && req.status === 'PENDING' && req.expires_at > this.now()) info.waiting_recovery = true;
    }
    return info;
  }

  join(roomId, sessionToken, { nickname, role }) {
    const { name, norm } = normalizeNickname(nickname);
    role = parseRole(role);
    return tx(this.db, () => {
      const room = this._room(roomId);
      if (!room) throw NOT_FOUND();
      const existing = this._session(roomId, sessionToken);
      if (existing && existing.me.status !== 'REJECTED') throw err(409, 'ALREADY_JOINED', 'このブラウザは既に参加しています');
      if (room.state !== 'LOBBY') throw err(409, 'NOT_JOINABLE', 'ゲームは開始済みのため、新しく参加できません。参加済みの人は「ゲームに戻る」から戻れます');
      if (role === 'A' && room.a_member_id) throw err(409, 'A_TAKEN', '飲む人は既に参加済みです。入れる人として参加してください');
      if (this.q("SELECT 1 FROM members WHERE room_id = ? AND nickname_norm = ? AND status IN ('PENDING','APPROVED')").get(room.id, norm)) {
        throw err(409, 'NAME_TAKEN', 'その名前は既に使われています。別の名前にしてください');
      }
      const mid = newId();
      this.q("INSERT INTO members (id, room_id, nickname, nickname_norm, role, status, is_host, joined_at) VALUES (?,?,?,?,?,'PENDING',0,?)")
        .run(mid, room.id, name, norm, role, this.now());
      this._log(room.id, 'JOIN_REQUESTED', mid);
      this._touch(room);
      return { sessionToken: this._issueSession(room, this._member(mid)) };
    });
  }

  approveMember(roomId, token, memberId) {
    return tx(this.db, () => {
      const { room, me } = this._host(roomId, token);
      if (room.state !== 'LOBBY') throw err(409, 'BAD_STATE', '開始後は参加を承認できません');
      const t = this._member(memberId);
      if (!t || t.room_id !== room.id || t.status !== 'PENDING') throw err(404, 'NOT_FOUND', '承認待ちの参加者が見つかりません');
      if (t.role === 'A') {
        if (room.a_member_id) throw err(409, 'A_TAKEN', '飲む人は既に決まっています。この参加申請は承認できません');
        this.q('UPDATE rooms SET a_member_id = ? WHERE id = ?').run(t.id, room.id);
      } else {
        this._saveOrder(room, [...room.b_order, t.id]);
      }
      this.q("UPDATE members SET status = 'APPROVED' WHERE id = ?").run(t.id);
      this._log(room.id, 'JOIN_APPROVED', me.id, t.id);
      this._touch(room);
      return { ok: true };
    });
  }

  rejectMember(roomId, token, memberId) {
    return tx(this.db, () => {
      const { room, me } = this._host(roomId, token);
      if (room.state !== 'LOBBY') throw err(409, 'BAD_STATE', '開始後は操作できません');
      const t = this._member(memberId);
      if (!t || t.room_id !== room.id || t.status !== 'PENDING') throw err(404, 'NOT_FOUND', '承認待ちの参加者が見つかりません');
      this.q("UPDATE members SET status = 'REJECTED' WHERE id = ?").run(t.id);
      this._log(room.id, 'JOIN_REJECTED', me.id, t.id);
      this._touch(room);
      return { ok: true };
    });
  }

  /** 開始前に承認済み参加者の参加を取り消す */
  removeMember(roomId, token, memberId) {
    return tx(this.db, () => {
      const { room, me } = this._host(roomId, token);
      if (room.state !== 'LOBBY') throw err(409, 'BAD_STATE', '開始後は参加を取り消せません');
      const t = this._member(memberId);
      if (!t || t.room_id !== room.id || t.status !== 'APPROVED') throw err(404, 'NOT_FOUND', '参加者が見つかりません');
      if (t.is_host) throw FORBIDDEN('進行役は取り消せません');
      this.q("UPDATE members SET status = 'REMOVED' WHERE id = ?").run(t.id);
      this._rotateAuth(t);
      if (room.a_member_id === t.id) this.q('UPDATE rooms SET a_member_id = NULL WHERE id = ?').run(room.id);
      this._saveOrder(room, room.b_order.filter((id) => id !== t.id));
      this._log(room.id, 'MEMBER_REMOVED', me.id, t.id);
      this._touch(room);
      return { ok: true };
    });
  }

  reorder(roomId, token, order) {
    return tx(this.db, () => {
      const { room, me } = this._host(roomId, token);
      if (room.state !== 'LOBBY') throw err(409, 'BAD_STATE', '開始後は順番を変えられません');
      if (!Array.isArray(order) || order.length !== room.b_order.length || new Set(order).size !== order.length || !order.every((id) => room.b_order.includes(id))) {
        throw err(400, 'BAD_ORDER', '順番の指定が不正です');
      }
      this._saveOrder(room, order);
      this._log(room.id, 'ORDER_CHANGED', me.id);
      this._touch(room);
      return { ok: true };
    });
  }

  start(roomId, token, requestId) {
    return tx(this.db, () => {
      const { room, me } = this._host(roomId, token);
      return this._idempotent(me, room, 'start', requestId, {}, () => {
        if (room.state !== 'LOBBY') throw err(409, 'BAD_STATE', 'ゲームは既に開始されています');
        if (!room.a_member_id) throw err(409, 'NEED_A', '飲む人が1人必要です');
        if (room.b_order.length < 1) throw err(409, 'NEED_B', '入れる人が1人以上必要です');
        const now = this.now();
        // 開始で新規参加を締め切る
        this.q("UPDATE members SET status = 'REJECTED' WHERE room_id = ? AND status = 'PENDING'").run(room.id);
        this.q("UPDATE rooms SET state = 'PLAYING', started_at = ?, current_b_index = 0 WHERE id = ?").run(now, room.id);
        room.state = 'PLAYING';
        this._log(room.id, 'STARTED', me.id);
        this._touch(room, { activity: true });
        return { ok: true };
      });
    });
  }

  // ---------- 1杯の進行 ----------

  _currentB(room) {
    return room.b_order[room.current_b_index % room.b_order.length];
  }

  _advance(room, fromIndex) {
    const next = (fromIndex + 1) % room.b_order.length;
    this.q('UPDATE rooms SET current_b_index = ? WHERE id = ?').run(next, room.id);
  }

  _requirePlaying(room) {
    if (room.state === 'PAUSED') throw err(409, 'PAUSED', '一時停止中です');
    if (room.state === 'FINISHED') throw err(409, 'FINISHED', 'ゲームは終了しています');
    if (room.state !== 'PLAYING') throw err(409, 'BAD_STATE', 'ゲームはまだ始まっていません');
  }

  submitActual(roomId, token, { request_id, count }) {
    return tx(this.db, () => {
      const { room, me } = this._approved(roomId, token);
      return this._idempotent(me, room, 'actual', request_id, { count }, () => {
        this._requirePlaying(room);
        if (me.role !== 'B' || this._currentB(room) !== me.id) throw FORBIDDEN('今はあなたの当番ではありません');
        if (this._openRound(room.id)) throw err(409, 'ALREADY_SUBMITTED', 'この杯の実投入数は記録済みです');
        const n = parseCount(count, this.cfg.maxCount);
        const number = (this.q('SELECT MAX(number) AS m FROM rounds WHERE room_id = ?').get(room.id).m ?? 0) + 1;
        const id = newId();
        this.q("INSERT INTO rounds (id, room_id, number, b_member_id, status, actual_count, actual_at) VALUES (?,?,?,?,'WAIT_GUESS',?,?)")
          .run(id, room.id, number, me.id, n, this.now());
        this._log(room.id, 'ACTUAL_SUBMITTED', me.id, String(number));
        this._touch(room, { activity: true });
        return { ok: true, round_id: id, number };
      });
    });
  }

  correctActual(roomId, token, { request_id, round_id, count, version }) {
    return tx(this.db, () => {
      const { room, me } = this._approved(roomId, token);
      return this._idempotent(me, room, 'correct', request_id, { round_id, count, version }, () => {
        this._requirePlaying(room);
        const r = this.q('SELECT * FROM rounds WHERE id = ? AND room_id = ?').get(String(round_id ?? ''), room.id);
        if (!r || r.b_member_id !== me.id) throw FORBIDDEN('自分が担当した杯だけ訂正できます');
        if (r.status !== 'WAIT_GUESS') throw err(409, 'GUESS_DONE', '飲む人の予想が確定したため訂正できません。必要なら進行役に無効化を頼んでください');
        if (r.version !== version) throw err(409, 'VERSION_CONFLICT', '状態が更新されました。画面を読み込み直してください');
        const n = parseCount(count, this.cfg.maxCount);
        this.q('INSERT INTO round_corrections (room_id, round_id, member_id, before_count, after_count, at) VALUES (?,?,?,?,?,?)')
          .run(room.id, r.id, me.id, r.actual_count, n, this.now());
        this.q('UPDATE rounds SET actual_count = ?, version = version + 1 WHERE id = ?').run(n, r.id);
        this._log(room.id, 'ACTUAL_CORRECTED', me.id, String(r.number));
        this._touch(room, { activity: true });
        return { ok: true, version: r.version + 1 };
      });
    });
  }

  submitGuess(roomId, token, { request_id, round_id, count, version }) {
    return tx(this.db, () => {
      const { room, me } = this._approved(roomId, token);
      return this._idempotent(me, room, 'guess', request_id, { round_id, count, version }, () => {
        this._requirePlaying(room);
        if (me.id !== room.a_member_id) throw FORBIDDEN('予想を入力できるのは飲む人だけです');
        const r = this._openRound(room.id);
        if (!r) throw err(409, 'NO_ACTUAL', 'まだ実投入数が記録されていません');
        if (r.id !== round_id) throw err(409, 'ROUND_CHANGED', '杯が切り替わりました。画面を確認してください');
        if (r.version !== version) throw err(409, 'ROUND_CHANGED', '入れた人が記録を訂正しました。予想をもう一度確認して確定してください');
        const n = parseCount(count, this.cfg.maxCount);
        this.q("UPDATE rounds SET guess_count = ?, fatigue_at_prediction = ?, guess_at = ?, status = 'COMPLETED', version = version + 1 WHERE id = ?")
          .run(n, me.fatigue, this.now(), r.id);
        this._advance(room, room.current_b_index);
        this._log(room.id, 'GUESS_SUBMITTED', me.id, String(r.number));
        this._touch(room, { activity: true });
        return { ok: true };
      });
    });
  }

  setFatigue(roomId, token, level) {
    return tx(this.db, () => {
      const { room, me } = this._approved(roomId, token);
      if (me.id !== room.a_member_id) throw FORBIDDEN('疲れ具合を記録できるのは飲む人だけです');
      if (room.state === 'FINISHED') throw err(409, 'FINISHED', 'ゲームは終了しています');
      if (level !== null && !(Number.isInteger(level) && level >= 0 && level <= 4)) throw err(400, 'BAD_FATIGUE', '疲れ具合の値が不正です');
      this.q('UPDATE members SET fatigue = ? WHERE id = ?').run(level, me.id);
      return { ok: true };
    });
  }

  // ---------- 進行役の操作 ----------

  skip(roomId, token, { request_id }) {
    return tx(this.db, () => {
      const { room, me } = this._host(roomId, token);
      return this._idempotent(me, room, 'skip', request_id, {}, () => {
        this._requirePlaying(room);
        if (this._openRound(room.id)) throw err(409, 'ACTUAL_DONE', '実投入数が確定済みの杯はスキップできません。無効化してください');
        this._advance(room, room.current_b_index);
        this._log(room.id, 'TURN_SKIPPED', me.id, this._currentB(room));
        this._touch(room, { activity: true });
        return { ok: true };
      });
    });
  }

  voidRound(roomId, token, { request_id, round_id, reason }) {
    return tx(this.db, () => {
      const { room, me } = this._host(roomId, token);
      return this._idempotent(me, room, 'void', request_id, { round_id, reason }, () => {
        if (room.state !== 'PLAYING' && room.state !== 'PAUSED') throw err(409, 'BAD_STATE', 'この状態では無効化できません');
        const why = parseReason(reason);
        const r = this.q('SELECT * FROM rounds WHERE id = ? AND room_id = ?').get(String(round_id ?? ''), room.id);
        if (!r) throw err(404, 'NOT_FOUND', '杯が見つかりません');
        if (r.status === 'VOID') throw err(409, 'ALREADY_VOID', 'この杯は既に無効です');
        this.q("UPDATE rounds SET status = 'VOID', void_reason = ?, voided_at = ?, voided_by = ?, version = version + 1 WHERE id = ?")
          .run(why, this.now(), me.id, r.id);
        // 現在の杯を無効化したら次のBへ。過去の杯なら当番は変えない
        if (r.status === 'WAIT_GUESS') this._advance(room, room.current_b_index);
        this._log(room.id, 'ROUND_VOIDED', me.id, String(r.number));
        this._touch(room, { activity: true });
        return { ok: true };
      });
    });
  }

  pause(roomId, token, { request_id }) {
    return tx(this.db, () => {
      const { room, me } = this._host(roomId, token);
      return this._idempotent(me, room, 'pause', request_id, {}, () => {
        if (room.state !== 'PLAYING') throw err(409, 'BAD_STATE', '進行中のときだけ一時停止できます');
        this.q("UPDATE rooms SET state = 'PAUSED' WHERE id = ?").run(room.id);
        room.state = 'PAUSED';
        this._log(room.id, 'PAUSED', me.id);
        this._touch(room, { activity: true });
        return { ok: true };
      });
    });
  }

  resume(roomId, token, { request_id }) {
    return tx(this.db, () => {
      const { room, me } = this._host(roomId, token);
      return this._idempotent(me, room, 'resume', request_id, {}, () => {
        if (room.state !== 'PAUSED') throw err(409, 'BAD_STATE', '一時停止中ではありません');
        this.q("UPDATE rooms SET state = 'PLAYING' WHERE id = ?").run(room.id);
        room.state = 'PLAYING';
        this._log(room.id, 'RESUMED', me.id);
        this._touch(room, { activity: true });
        return { ok: true };
      });
    });
  }

  /** void_open=true なら、予想未確定の杯を無効にして終了する */
  finish(roomId, token, { request_id, void_open = false, reason }) {
    return tx(this.db, () => {
      const { room, me } = this._host(roomId, token);
      return this._idempotent(me, room, 'finish', request_id, { void_open, reason: reason ?? null }, () => {
        if (room.state !== 'PLAYING' && room.state !== 'PAUSED') throw err(409, 'BAD_STATE', 'この状態では終了できません');
        const open = this._openRound(room.id);
        if (open) {
          if (!void_open) throw err(409, 'OPEN_ROUND', `第${open.number}杯は飲む人の予想が未確定です。予想を待つか、この杯を無効にして終了してください`);
          const why = reason === undefined || reason === null || reason === '' ? '予想未確定のまま終了' : parseReason(reason);
          this.q("UPDATE rounds SET status = 'VOID', void_reason = ?, voided_at = ?, voided_by = ?, version = version + 1 WHERE id = ?")
            .run(why, this.now(), me.id, open.id);
        }
        // 準備待ちの空の杯は行を作っていないので、結果に混ざらない
        const now = this.now();
        this.q("UPDATE rooms SET state = 'FINISHED', finished_at = ?, expires_at = ?, version = version + 1 WHERE id = ?")
          .run(now, now + this.cfg.finishedTtlMs, room.id);
        this._log(room.id, 'FINISHED', me.id);
        return { ok: true };
      });
    });
  }

  deleteRoom(roomId, token, { confirm }) {
    return tx(this.db, () => {
      const { room } = this._host(roomId, token);
      if (room.state !== 'FINISHED') throw err(409, 'BAD_STATE', '終了したゲームだけ削除できます');
      if (confirm !== true) throw err(400, 'CONFIRM_REQUIRED', '削除の確認が必要です');
      this.q('DELETE FROM rooms WHERE id = ?').run(room.id);
      return { ok: true };
    });
  }

  // ---------- 復帰 ----------

  /** 招待URLを持つ人に見せてよいのは、承認済み参加者の表示名だけ */
  recoveryNames(roomId) {
    const room = this._room(roomId);
    if (!room) throw NOT_FOUND();
    return {
      members: this._members(room.id).filter((m) => m.status === 'APPROVED').map((m) => ({ id: m.id, nickname: m.nickname })),
    };
  }

  requestRecovery(roomId, sessionToken, memberId) {
    return tx(this.db, () => {
      const room = this._room(roomId);
      if (!room) throw NOT_FOUND();
      const existing = this._session(roomId, sessionToken);
      if (existing && existing.me.status !== 'REJECTED') throw err(409, 'ALREADY_AUTHENTICATED', 'このブラウザは既にこのゲームに参加しています');
      const t = this._member(memberId);
      if (!t || t.room_id !== room.id || t.status !== 'APPROVED') throw err(404, 'NOT_FOUND', '参加者が見つかりません');
      const now = this.now();
      const number = room.recovery_seq + 1;
      const waitToken = newToken();
      const expires = Math.min(now + this.cfg.recoveryRequestTtlMs, room.expires_at);
      // 同じ人への申請は最新の1件だけにする（承認する側が取り違えないように）
      this.q("UPDATE recovery_requests SET status = 'EXPIRED' WHERE member_id = ? AND status = 'PENDING'").run(t.id);
      this.q('UPDATE rooms SET recovery_seq = ?, version = version + 1 WHERE id = ?').run(number, room.id);
      this.q("INSERT INTO recovery_requests (id, room_id, member_id, wait_hash, number, generation, status, created_at, expires_at) VALUES (?,?,?,?,?,?,'PENDING',?,?)")
        .run(newId(), room.id, t.id, hashToken(waitToken), number, t.auth_generation, now, expires);
      this._log(room.id, 'RECOVERY_REQUESTED', null, t.id);
      return { waitToken, nickname: t.nickname, expires_at: expires };
    });
  }

  /** 申請者の待機画面から呼ぶ。承認済みなら新しいセッションを発行する。 */
  recoveryStatus(roomId, waitToken) {
    return tx(this.db, () => {
      const room = this._room(roomId);
      if (!room) throw NOT_FOUND();
      const req = waitToken ? this.q('SELECT * FROM recovery_requests WHERE wait_hash = ? AND room_id = ?').get(hashToken(waitToken), room.id) : null;
      if (!req) throw err(404, 'NO_REQUEST', '復帰申請が見つかりません');
      const t = this._member(req.member_id);
      const base = { nickname: t?.nickname ?? '' };
      if (req.status === 'PENDING') {
        if (req.expires_at <= this.now()) {
          this.q("UPDATE recovery_requests SET status = 'EXPIRED' WHERE id = ?").run(req.id);
          return { ...base, status: 'EXPIRED' };
        }
        return { ...base, status: 'PENDING', expires_at: req.expires_at };
      }
      if (req.status === 'APPROVED') {
        if (!t || t.status !== 'APPROVED' || t.auth_generation !== req.approved_generation || req.decided_at + this.cfg.recoveryRequestTtlMs <= this.now()) {
          this.q("UPDATE recovery_requests SET status = 'EXPIRED' WHERE id = ?").run(req.id);
          return { ...base, status: 'EXPIRED' };
        }
        this.q("UPDATE recovery_requests SET status = 'CLAIMED' WHERE id = ?").run(req.id);
        return { ...base, status: 'APPROVED', sessionToken: this._issueSession(room, t) };
      }
      return { ...base, status: req.status === 'CLAIMED' ? 'EXPIRED' : req.status };
    });
  }

  decideRecovery(roomId, token, { request_id: reqId, approve }) {
    return tx(this.db, () => {
      const { room, me } = this._approved(roomId, token);
      const req = this.q('SELECT * FROM recovery_requests WHERE id = ? AND room_id = ?').get(String(reqId ?? ''), room.id);
      if (!req || req.status !== 'PENDING') throw err(404, 'NOT_FOUND', '処理できる復帰申請がありません');
      if (req.expires_at <= this.now()) {
        this.q("UPDATE recovery_requests SET status = 'EXPIRED' WHERE id = ?").run(req.id);
        throw err(409, 'EXPIRED', 'この申請は期限切れです');
      }
      const t = this._member(req.member_id);
      if (!t || t.status !== 'APPROVED') throw err(404, 'NOT_FOUND', '参加者が見つかりません');
      // 本人以外の参加者なら誰でも許可できる（進行役本人の復帰も同じ）
      if (t.id === me.id) throw FORBIDDEN('自分自身の復帰は許可できません');
      const now = this.now();
      if (!approve) {
        this.q("UPDATE recovery_requests SET status = 'REJECTED', approver_member_id = ?, decided_at = ? WHERE id = ?").run(me.id, now, req.id);
        this._log(room.id, 'RECOVERY_REJECTED', me.id, t.id);
        this._touch(room);
        return { ok: true };
      }
      if (t.auth_generation !== req.generation) {
        this.q("UPDATE recovery_requests SET status = 'EXPIRED' WHERE id = ?").run(req.id);
        throw err(409, 'STALE', 'この申請の後に認証状態が変わりました。もう一度申請してもらってください');
      }
      const gen = this._rotateAuth(t); // 旧認証情報・他の申請を失効
      this.q("UPDATE recovery_requests SET status = 'APPROVED', approver_member_id = ?, decided_at = ?, approved_generation = ? WHERE id = ?")
        .run(me.id, now, gen, req.id);
      this._log(room.id, 'RECOVERY_APPROVED', me.id, t.id);
      this._touch(room);
      return { ok: true };
    });
  }

  // ---------- 読み取り（役割別に組み立てる） ----------

  /**
   * 状態取得。終了前は、実投入数・予想数・正誤・集計値を一切含めない。
   * 含めてよいのは、部屋の状態・杯番号・当番・実投入/予想の確定有無・完了杯数・版番号。
   */
  state(roomId, token) {
    const { room, me } = this._auth(roomId, token);
    const base = { room: { id: room.id, state: room.state, version: room.version, expires_at: room.expires_at } };
    if (me.status !== 'APPROVED') {
      return { ...base, me: { id: me.id, nickname: me.nickname, role: me.role, status: me.status, is_host: false } };
    }
    const members = this._members(room.id);
    const byId = new Map(members.map((m) => [m.id, m]));
    const name = (id) => byId.get(id)?.nickname ?? '';
    const approved = members.filter((m) => m.status === 'APPROVED');

    const out = {
      ...base,
      room: { ...base.room, invite_token: room.invite_token, host_member_id: room.host_member_id, created_at: room.created_at, started_at: room.started_at, finished_at: room.finished_at },
      me: { id: me.id, nickname: me.nickname, role: me.role, status: me.status, is_host: !!me.is_host },
      members: approved.map((m) => ({ id: m.id, nickname: m.nickname, role: m.role, is_host: !!m.is_host })),
      a_member_id: room.a_member_id,
      b_order: room.b_order.map((id) => ({ id, nickname: name(id) })),
      pending_members: [],
      recovery_requests: [],
      current: null,
      rounds: [],
      completed_count: 0,
    };
    if (me.id === room.a_member_id) out.me.fatigue = me.fatigue;

    if (me.is_host && room.state === 'LOBBY') {
      out.pending_members = members.filter((m) => m.status === 'PENDING').map((m) => ({ id: m.id, nickname: m.nickname, role: m.role }));
    }
    const reqs = this.q("SELECT * FROM recovery_requests WHERE room_id = ? AND status = 'PENDING' AND expires_at > ? ORDER BY number").all(room.id, this.now());
    out.recovery_requests = reqs
      .filter((r) => r.member_id !== me.id)
      .map((r) => ({ id: r.id, nickname: name(r.member_id), created_at: r.created_at }));

    const rounds = this._rounds(room.id);
    out.completed_count = rounds.filter((r) => r.status === 'COMPLETED').length;
    // 番号と状態のみ。数値は入れない。無効理由は終了前は進行役だけ。
    out.rounds = rounds.map((r) => ({
      id: r.id, number: r.number, b_nickname: name(r.b_member_id), status: r.status === 'WAIT_GUESS' ? 'WAIT_GUESS' : r.status,
      ...(me.is_host && r.status === 'VOID' ? { void_reason: r.void_reason } : {}),
    }));

    if (room.state === 'PLAYING' || room.state === 'PAUSED') {
      const open = this._openRound(room.id);
      if (open) {
        out.current = { phase: 'WAIT_GUESS', number: open.number, b_member_id: open.b_member_id, b_nickname: name(open.b_member_id), actual_submitted: true, guess_submitted: false };
        if (me.id === room.a_member_id || me.id === open.b_member_id) Object.assign(out.current, { round_id: open.id, round_version: open.version });
      } else {
        const bId = this._currentB(room);
        const number = (rounds.length ? rounds[rounds.length - 1].number : 0) + 1;
        out.current = { phase: 'WAIT_ACTUAL', number, b_member_id: bId, b_nickname: name(bId), actual_submitted: false, guess_submitted: false };
      }
    }
    return out;
  }

  /** 終了前に本人の値だけを見る専用の操作。Bは自分が担当した杯の実投入数、Aは自分の予想。 */
  mine(roomId, token) {
    const { room, me } = this._approved(roomId, token);
    const rounds = this._rounds(room.id);
    if (me.role === 'B') {
      return {
        role: 'B',
        rounds: rounds.filter((r) => r.b_member_id === me.id).map((r) => ({
          id: r.id, number: r.number, status: r.status, actual_count: r.actual_count, version: r.version,
          correctable: r.status === 'WAIT_GUESS' && room.state === 'PLAYING',
        })),
      };
    }
    return {
      role: 'A',
      rounds: rounds.filter((r) => r.guess_count !== null).map((r) => ({ number: r.number, status: r.status, guess_count: r.guess_count })),
    };
  }

  _resultData(room) {
    const members = this._members(room.id);
    const byId = new Map(members.map((m) => [m.id, m]));
    const name = (id) => byId.get(id)?.nickname ?? '';
    const rounds = this._rounds(room.id);
    const bMembers = room.b_order.map((id) => byId.get(id)).filter(Boolean);
    const textArgs = { heldAt: room.started_at ?? room.created_at, timezone: this.cfg.timezone, timezoneLabel: this.cfg.timezoneLabel, aName: name(room.a_member_id), rounds, nameOf: name };
    return { members, name, rounds, bMembers, textArgs };
  }

  result(roomId, token) {
    const { room, me } = this._approved(roomId, token);
    if (room.state !== 'FINISHED') throw FORBIDDEN('結果はゲーム終了後に公開されます');
    const { name, rounds, bMembers, textArgs } = this._resultData(room);
    return {
      room: { id: room.id, state: room.state, started_at: room.started_at, finished_at: room.finished_at, expires_at: room.expires_at },
      me: { id: me.id, is_host: !!me.is_host, role: me.role },
      a_nickname: name(room.a_member_id),
      stats: computeStats(rounds),
      by_b: computeStatsByB(rounds, bMembers),
      rounds: rounds.map((r) => ({
        number: r.number, b_nickname: name(r.b_member_id), status: r.status,
        actual_count: r.actual_count, guess_count: r.guess_count,
        error: r.status === 'COMPLETED' ? r.guess_count - r.actual_count : null,
        fatigue: r.fatigue_at_prediction, void_reason: r.void_reason,
      })),
      fatigue_labels: FATIGUE_LABELS,
      text: formatResultText(textArgs),
      text_anonymous: formatResultText({ ...textArgs, anonymous: true }),
    };
  }

  /** JSON書き出し。認証情報・Cookie・復帰トークン・招待URLは含めない。 */
  exportJson(roomId, token) {
    const { room } = this._approved(roomId, token);
    if (room.state !== 'FINISHED') throw FORBIDDEN('書き出しはゲーム終了後にできます');
    const { members, name, rounds, bMembers } = this._resultData(room);
    const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
    const corrections = this.q('SELECT * FROM round_corrections WHERE room_id = ? ORDER BY id').all(room.id);
    const roundNo = new Map(rounds.map((r) => [r.id, r.number]));
    return {
      schema_version: SCHEMA_VERSION,
      app: 'lemon-score',
      exported_at: iso(this.now()),
      settings: { max_count: this.cfg.maxCount, retention_finished_days: this.cfg.finishedTtlMs / 86400_000, timezone: this.cfg.timezone },
      game: { created_at: iso(room.created_at), started_at: iso(room.started_at), finished_at: iso(room.finished_at) },
      participants: members.filter((m) => m.status === 'APPROVED').map((m) => ({ nickname: m.nickname, role: m.role, is_host: !!m.is_host, b_order: m.role === 'B' ? room.b_order.indexOf(m.id) + 1 : null })),
      rounds: rounds.map((r) => ({
        number: r.number, b: name(r.b_member_id), status: r.status === 'COMPLETED' ? 'COMPLETED' : 'VOID',
        actual_count: r.actual_count, guess_count: r.guess_count,
        error: r.status === 'COMPLETED' ? r.guess_count - r.actual_count : null,
        fatigue_at_prediction: r.fatigue_at_prediction,
        actual_at: iso(r.actual_at), guess_at: iso(r.guess_at),
        void_reason: r.void_reason, voided_at: iso(r.voided_at),
      })),
      corrections: corrections.map((c) => ({ round: roundNo.get(c.round_id), by: name(c.member_id), before: c.before_count, after: c.after_count, at: iso(c.at) })),
      stats: computeStats(rounds),
      stats_by_b: computeStatsByB(rounds, bMembers).map(({ member_id, ...rest }) => rest),
    };
  }

  /** このブラウザが参加している保存期間内のゲーム（Cookieから） */
  myRooms(sessions) {
    const out = [];
    for (const [roomId, token] of sessions) {
      const a = this._session(roomId, token);
      if (!a) continue;
      out.push({ room_id: a.room.id, invite_token: a.room.invite_token, state: a.room.state, nickname: a.me.nickname, status: a.me.status, created_at: a.room.created_at, expires_at: a.room.expires_at });
    }
    return out.sort((x, y) => y.created_at - x.created_at);
  }

  // ---------- 期限切れの削除 ----------

  cleanup() {
    const now = this.now();
    return tx(this.db, () => {
      const r = this.q('DELETE FROM rooms WHERE expires_at <= ?').run(now);
      this.q("UPDATE recovery_requests SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at <= ?").run(now);
      this.q('DELETE FROM idempotency WHERE created_at <= ?').run(now - 7 * 86400_000);
      return Number(r.changes);
    });
  }
}
