import crypto from 'node:crypto';

export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const newId = () => crypto.randomBytes(12).toString('base64url');
export const newToken = () => crypto.randomBytes(24).toString('base64url');
export const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

export function normalizeNickname(raw) {
  if (typeof raw !== 'string') throw new AppError(400, 'BAD_NICKNAME', 'ニックネームを入力してください');
  const name = raw.normalize('NFC').trim().replace(/\s+/gu, ' ');
  const len = [...name].length;
  if (len < 1 || len > 20) throw new AppError(400, 'BAD_NICKNAME', 'ニックネームは1〜20文字で入力してください');
  if (/[\p{Cc}\p{Cf}]/u.test(name)) throw new AppError(400, 'BAD_NICKNAME', 'ニックネームに使えない文字が含まれています');
  return { name, norm: name.normalize('NFKC').toLowerCase().replace(/\s+/gu, '') };
}

export function parseCount(v, max) {
  // 0以上の整数のみ。空欄・負数・小数・文字列・上限超過は拒否
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) {
    throw new AppError(400, 'BAD_COUNT', `個数は0〜${max}の整数で入力してください`);
  }
  return v;
}

export function parseRole(v) {
  if (v !== 'A' && v !== 'B') throw new AppError(400, 'BAD_ROLE', '役割を選んでください');
  return v;
}

export function parseReason(v) {
  if (typeof v !== 'string') throw new AppError(400, 'BAD_REASON', '無効にする理由を入力してください');
  const s = v.normalize('NFC').trim().replace(/[\p{Cc}\p{Cf}]/gu, ' ');
  const len = [...s].length;
  if (len < 1 || len > 100) throw new AppError(400, 'BAD_REASON', '理由は1〜100文字で入力してください');
  return s;
}
