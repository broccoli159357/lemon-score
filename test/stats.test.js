import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, formatResultText, fmtNum, fmtBias, cupCondition, conditionComment, totalLemons } from '../src/stats.js';

const example = [
  [1, 'はな', 3, 3], [2, 'じろう', 6, 4], [3, 'はな', 2, 3], [4, 'じろう', 8, 7], [5, 'はな', 0, 1],
].map(([number, b, actual_count, guess_count]) => ({ number, b_member_id: b, status: 'COMPLETED', actual_count, guess_count }));

test('受け入れ16: 第10章の5杯の例', () => {
  const s = computeStats(example);
  assert.equal(s.valid_count, 5);
  assert.equal(s.correct_count, 1);
  assert.equal(s.accuracy, 20);
  assert.equal(s.mean_abs_error, 1);
  assert.ok(Math.abs(s.bias - -0.2) < 1e-12);
  assert.equal(s.max_abs_error, 2);
  assert.equal(s.within_one_rate, 80);
});

test('結果テキストが仕様の例と一致する', () => {
  const text = formatResultText({
    heldAt: Date.UTC(2026, 9, 10, 10, 30), timezone: 'Asia/Tokyo', timezoneLabel: '日本時間',
    aName: 'たろう', rounds: example, nameOf: (x) => x,
  });
  assert.equal(text, [
    'レモンスコア',
    '2026/10/10 19:30（日本時間）',
    '飲む人：たろう',
    '🍋合計レモン：19個',
    '有効：5杯 / 正解：1杯（20%）',
    '平均のズレ：1個',
    '予想の偏り：−0.2個（少なめ）',
    '最大のズレ：2個',
    '±1以内：80%',
    '調子：😊まだ元気そう？',
    '',
    '1杯目［はな］実3 → 予想3：🎯正解',
    '2杯目［じろう］実6 → 予想4：−2',
    '3杯目［はな］実2 → 予想3：＋1',
    '4杯目［じろう］実8 → 予想7：−1',
    '5杯目［はな］実0 → 予想1：＋1',
  ].join('\n'));
});

test('匿名形式は名前を含まない', () => {
  const text = formatResultText({ heldAt: 0, timezone: 'Asia/Tokyo', timezoneLabel: '日本時間', aName: 'たろう', rounds: example, nameOf: (x) => x, anonymous: true });
  assert.ok(!text.includes('たろう'));
  assert.ok(!text.includes('はな'));
  assert.ok(text.includes('1杯目 実3 → 予想3：🎯正解'));
});

test('受け入れ14: 0杯・無効のみでもゼロ除算しない', () => {
  const s = computeStats([{ number: 1, status: 'VOID', actual_count: 3, guess_count: null, void_reason: 'こぼした' }]);
  assert.deepEqual(s, { valid_count: 0, correct_count: 0, accuracy: null, mean_abs_error: null, bias: null, max_abs_error: null, within_one_rate: null });
  const text = formatResultText({ heldAt: 0, timezone: 'Asia/Tokyo', timezoneLabel: '日本時間', aName: 'A', rounds: [{ number: 1, status: 'VOID', void_reason: 'こぼした' }], nameOf: () => 'B' });
  assert.ok(text.includes('有効：0杯 / 正解：0杯（—）'));
  assert.ok(text.includes('平均のズレ：—'));
  assert.ok(text.includes('無効：第1杯（こぼした）'));
  assert.ok(!text.includes('NaN') && !text.includes('Infinity'));
});

test('数値の丸めと末尾0の省略', () => {
  assert.equal(fmtNum(33.333333, 1), '33.3');
  assert.equal(fmtNum(1.5, 2), '1.5');
  assert.equal(fmtNum(2, 2), '2');
  assert.equal(fmtNum(-0.0001, 2), '0');
  assert.equal(fmtBias(0), '0個（偏りなし）');
  assert.equal(fmtBias(0.25), '＋0.25個（多め）');
});

const cups = (pairs) => pairs.map(([actual_count, guess_count], i) => ({ number: i + 1, status: 'COMPLETED', actual_count, guess_count }));

test('1杯ごとの調子：ズレが小さいほど元気', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 10].map(cupCondition), [
    'ぴったり！冴えてる', '元気そう', 'ちょっと疲れてる？', 'ちょっと疲れてる？', '疲れていませんか？', '疲れていませんか？',
  ]);
});

test('全体の調子：平均のズレで4段階、前半と後半の差で傾向', () => {
  assert.equal(conditionComment([]), null);
  assert.equal(conditionComment([{ number: 1, status: 'VOID', actual_count: 1, guess_count: null }]), null);
  assert.equal(conditionComment(cups([[3, 3], [5, 5]])).level, 0);
  assert.equal(conditionComment(cups([[3, 4], [5, 5]])).level, 0); // 平均0.5まではバッチリ
  assert.equal(conditionComment(cups([[3, 4], [5, 6]])).level, 1);
  assert.equal(conditionComment(cups([[3, 6], [5, 5]])).level, 1);
  assert.equal(conditionComment(cups([[3, 6], [5, 8]])).level, 2);
  assert.equal(conditionComment(cups([[1, 9]])).level, 3);
  assert.equal(conditionComment(cups([[3, 3], [5, 5]])).trend, null); // 3杯以下は傾向を出さない
  assert.equal(conditionComment(cups([[3, 3], [5, 5], [4, 6], [2, 5]])).trend, '後半はズレが大きめ。疲れてきたかも？');
  assert.equal(conditionComment(cups([[3, 6], [5, 3], [4, 4], [2, 2]])).trend, '後半のほうが冴えてる！調子が出てきた？');
  // 無効杯は判定に含めない
  const withVoid = [...cups([[3, 3]]), { number: 2, status: 'VOID', actual_count: 1, guess_count: 9 }];
  assert.equal(conditionComment(withVoid).level, 0);
});

test('有効杯0なら結果テキストに調子の行を出さない', () => {
  const text = formatResultText({ heldAt: 0, timezone: 'Asia/Tokyo', timezoneLabel: '日本時間', aName: 'A', rounds: [], nameOf: () => '' });
  assert.ok(!text.includes('調子'));
});

test('合計レモン：予想まで済んだ杯（＝飲んだ杯）の実投入数の合計', () => {
  assert.equal(totalLemons([]), 0);
  assert.equal(totalLemons([
    { number: 1, status: 'COMPLETED', actual_count: 3, guess_count: 4 },
    { number: 2, status: 'VOID', actual_count: 5, guess_count: 2, void_reason: '入力ミス' }, // 飲んでから無効 → 含める
    { number: 3, status: 'VOID', actual_count: 7, guess_count: null, void_reason: 'こぼした' }, // 飲む前に無効 → 含めない
  ]), 8);
});
