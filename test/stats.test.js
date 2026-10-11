import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, formatResultText, fmtNum, fmtBias } from '../src/stats.js';

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
    '有効：5杯 / 正解：1杯（20%）',
    '平均のズレ：1個',
    '予想の偏り：−0.2個（少なめ）',
    '最大のズレ：2個',
    '±1以内：80%',
    '',
    '1杯目［はな］実3 → 予想3：正解',
    '2杯目［じろう］実6 → 予想4：−2',
    '3杯目［はな］実2 → 予想3：＋1',
    '4杯目［じろう］実8 → 予想7：−1',
    '5杯目［はな］実0 → 予想1：＋1',
    '',
    'ズレは「予想−実投入」。',
  ].join('\n'));
});

test('匿名形式は名前を含まない', () => {
  const text = formatResultText({ heldAt: 0, timezone: 'Asia/Tokyo', timezoneLabel: '日本時間', aName: 'たろう', rounds: example, nameOf: (x) => x, anonymous: true });
  assert.ok(!text.includes('たろう'));
  assert.ok(!text.includes('はな'));
  assert.ok(text.includes('1杯目 実3 → 予想3：正解'));
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
