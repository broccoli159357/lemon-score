import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  invite_token TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('LOBBY','PLAYING','PAUSED','FINISHED')),
  host_member_id TEXT,
  a_member_id TEXT,
  b_order TEXT NOT NULL DEFAULT '[]',
  current_b_index INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  last_activity_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  recovery_seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS rooms_expires ON rooms(expires_at);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL,
  nickname_norm TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('A','B')),
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','REMOVED')),
  is_host INTEGER NOT NULL DEFAULT 0,
  auth_generation INTEGER NOT NULL DEFAULT 1,
  fatigue INTEGER CHECK (fatigue IS NULL OR fatigue BETWEEN 0 AND 4),
  joined_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS members_name_unique ON members(room_id, nickname_norm)
  WHERE status IN ('PENDING','APPROVED');
CREATE UNIQUE INDEX IF NOT EXISTS members_single_a ON members(room_id)
  WHERE role = 'A' AND status = 'APPROVED';

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_member ON sessions(member_id);

CREATE TABLE IF NOT EXISTS recovery_requests (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  wait_hash TEXT NOT NULL UNIQUE,
  number INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED','CLAIMED')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approver_member_id TEXT,
  decided_at INTEGER,
  approved_generation INTEGER
);
CREATE INDEX IF NOT EXISTS recovery_requests_room ON recovery_requests(room_id, status);

CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  b_member_id TEXT NOT NULL REFERENCES members(id),
  status TEXT NOT NULL CHECK (status IN ('WAIT_GUESS','COMPLETED','VOID')),
  actual_count INTEGER,
  guess_count INTEGER,
  fatigue_at_prediction INTEGER,
  actual_at INTEGER,
  guess_at INTEGER,
  void_reason TEXT,
  voided_at INTEGER,
  voided_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (room_id, number)
);
-- 同じ部屋に同時進行の杯は1つだけ
CREATE UNIQUE INDEX IF NOT EXISTS rounds_single_open ON rounds(room_id) WHERE status = 'WAIT_GUESS';

CREATE TABLE IF NOT EXISTS round_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  before_count INTEGER NOT NULL,
  after_count INTEGER NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency (
  member_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  op TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (member_id, request_id)
);

-- 共通ログ。実投入数・予想数などの機密数値は入れない
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  actor_member_id TEXT,
  target TEXT,
  at INTEGER NOT NULL
);
`;

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  return db;
}

// 書き込みはすべてこの中で行う。node:sqlite は同期APIなので、1プロセス内では
// トランザクション単位で完全に直列化される（BEGIN IMMEDIATE で別プロセスとも排他）。
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
