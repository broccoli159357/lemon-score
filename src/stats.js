// 集計（第10章）。有効な完了杯（status=COMPLETED）だけを対象にする。内部では丸めない。

const MINUS = '−'; // U+2212
const PLUS = '＋';

export function computeStats(rounds) {
  const valid = rounds.filter((r) => r.status === 'COMPLETED');
  const n = valid.length;
  const errs = valid.map((r) => r.guess_count - r.actual_count);
  if (n === 0) {
    return { valid_count: 0, correct_count: 0, accuracy: null, mean_abs_error: null, bias: null, max_abs_error: null, within_one_rate: null };
  }
  const abs = errs.map(Math.abs);
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const correct = errs.filter((e) => e === 0).length;
  return {
    valid_count: n,
    correct_count: correct,
    accuracy: (correct / n) * 100,
    mean_abs_error: sum(abs) / n,
    bias: sum(errs) / n,
    max_abs_error: Math.max(...abs),
    within_one_rate: (abs.filter((e) => e <= 1).length / n) * 100,
  };
}

export function computeStatsByB(rounds, bMembers) {
  return bMembers.map((m) => {
    const s = computeStats(rounds.filter((r) => r.b_member_id === m.id));
    return { member_id: m.id, nickname: m.nickname, valid_count: s.valid_count, correct_count: s.correct_count, accuracy: s.accuracy, mean_abs_error: s.mean_abs_error };
  });
}

// ---------- 調子の目安（疲れ具合の自己申告の代わり） ----------
// ズレが小さい＝疲れていない、ズレが大きい＝疲れ寄り、という遊びの判定。
// 実投入数・ソーダの量などは統制していないため、あくまで目安として表示する。

/** 1杯ごとのひとこと（ズレの絶対値から） */
export function cupCondition(absError) {
  if (absError === 0) return 'ぴったり！冴えてる';
  if (absError === 1) return '元気そう';
  if (absError <= 3) return 'ちょっと疲れてる？';
  return '疲れていませんか？';
}

const CONDITION_LEVELS = [
  [0.5, '疲れてなさそう！感覚バッチリ'],
  [1.5, 'まだ元気そう？'],
  [3, 'ちょっと疲れていませんか？'],
  [Infinity, 'だいぶ疲れていませんか？ひと休みしよう'],
];

/**
 * 全体のひとこと。有効杯が0なら null。
 * 4杯以上あれば前半と後半の平均のズレを比べ、1個以上の差で傾向を添える。
 */
export function conditionComment(rounds) {
  const valid = rounds.filter((r) => r.status === 'COMPLETED').sort((a, b) => a.number - b.number);
  if (!valid.length) return null;
  const abs = valid.map((r) => Math.abs(r.guess_count - r.actual_count));
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const m = mean(abs);
  const level = CONDITION_LEVELS.findIndex(([max]) => m <= max);
  let trend = null;
  if (abs.length >= 4) {
    const half = Math.floor(abs.length / 2);
    const diff = mean(abs.slice(abs.length - half)) - mean(abs.slice(0, half));
    if (diff >= 1) trend = '後半はズレが大きめ。疲れてきたかも？';
    else if (diff <= -1) trend = '後半のほうが冴えてる！調子が出てきた？';
  }
  return { level, text: CONDITION_LEVELS[level][1], trend };
}

/** 小数 digits 桁で丸め、末尾の不要な0を省く。負号はU+2212。 */
export function fmtNum(x, digits) {
  if (x === null || x === undefined) return '—';
  let s = Number(x.toFixed(digits)).toString();
  if (s === '-0') s = '0';
  return s.replace('-', MINUS);
}

export function fmtSigned(x, digits = 0) {
  const s = fmtNum(x, digits);
  if (s === '0' || s === '—' || s.startsWith(MINUS)) return s;
  return PLUS + s;
}

export function fmtPercent(x) {
  return x === null ? '—' : `${fmtNum(x, 1)}%`;
}

export function fmtBias(x) {
  if (x === null) return '—';
  const s = fmtSigned(x, 2);
  if (s === '0') return '0個（偏りなし）';
  return `${s}個（${x < 0 ? '少なめ' : '多め'}）`;
}

export function fmtUnit(x, digits, unit) {
  return x === null ? '—' : `${fmtNum(x, digits)}${unit}`;
}

export function roundDiffLabel(r) {
  const e = r.guess_count - r.actual_count;
  return e === 0 ? '正解' : fmtSigned(e);
}

export function formatDateTime(ms, timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('ja-JP', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

/**
 * LINE等へ貼るためのプレーンテキスト。空白による列揃えに依存しない。
 * 招待URL・認証情報・復帰リンクは含めない。
 */
export function formatResultText({ heldAt, timezone, timezoneLabel, aName, rounds, nameOf, anonymous = false }) {
  const st = computeStats(rounds);
  const lines = ['レモンスコア'];
  lines.push(formatDateTime(heldAt, timezone) + (timezoneLabel ? `（${timezoneLabel}）` : ''));
  if (!anonymous) lines.push(`飲む人：${aName}`);
  lines.push(`有効：${st.valid_count}杯 / 正解：${st.correct_count}杯（${fmtPercent(st.accuracy)}）`);
  lines.push(`平均のズレ：${fmtUnit(st.mean_abs_error, 2, '個')}`);
  lines.push(`予想の偏り：${fmtBias(st.bias)}`);
  lines.push(`最大のズレ：${fmtUnit(st.max_abs_error, 0, '個')}`);
  lines.push(`±1以内：${fmtPercent(st.within_one_rate)}`);
  const cond = conditionComment(rounds);
  if (cond) lines.push(`調子：${cond.text}${cond.trend ? `（${cond.trend}）` : ''}`);

  const sorted = [...rounds].sort((a, b) => a.number - b.number);
  const valid = sorted.filter((r) => r.status === 'COMPLETED');
  if (valid.length) lines.push('');
  for (const r of valid) {
    const who = anonymous ? '' : `［${nameOf(r.b_member_id)}］`;
    lines.push(`${r.number}杯目${who}${anonymous ? ' ' : ''}実${r.actual_count} → 予想${r.guess_count}：${roundDiffLabel(r)}`);
  }
  const voids = sorted.filter((r) => r.status === 'VOID');
  if (voids.length) {
    lines.push('');
    for (const r of voids) lines.push(`無効：第${r.number}杯（${r.void_reason}）`);
  }
  lines.push('');
  lines.push('ズレは「予想−実投入」。');
  return lines.join('\n');
}
