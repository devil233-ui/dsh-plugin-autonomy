/**
 * 心情调制（`src/core/mood.ts`）的钉子。
 *
 * 只钉两件事：读不出来就当没有；读出来了只挪阈值与条数，且方向不能反。
 * 节奏不在这一层，这里也一个字都不碰。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MOOD_HIGH, MOOD_LOW, moodTuning, readMood } from '../src/core/mood.js';

const BASE = { threshold: 0.5, max: 3 };

test('readMood 只认有数值的回包', () => {
  assert.deepEqual(readMood({ value: 42, label: '平静' }), { value: 42, label: '平静' });
  assert.deepEqual(readMood({ value: '17' }), { value: 17, label: '' });
  assert.deepEqual(readMood({ value: 500, label: '兴奋' }), { value: 100, label: '兴奋' });
  assert.equal(readMood(undefined), undefined);
  assert.equal(readMood(null), undefined);
  assert.equal(readMood({ label: '平静' }), undefined);
  assert.equal(readMood({ value: 'abc' }), undefined);
});

test('心情低：门槛抬高、候选减到 2', () => {
  const tuning = moodTuning({ value: MOOD_LOW - 10, label: '低落' }, BASE);
  assert.equal(tuning.threshold, 0.6);
  assert.equal(tuning.max, 2);
  assert.match(tuning.note, /low/);
});

test('心情高：门槛下调、条数不变', () => {
  const tuning = moodTuning({ value: MOOD_HIGH + 10, label: '兴奋' }, BASE);
  assert.equal(tuning.threshold, 0.45);
  assert.equal(tuning.max, BASE.max);
  assert.match(tuning.note, /high/);
});

test('中间档与读不到：原样不动', () => {
  const mid = moodTuning({ value: 60, label: '平静' }, BASE);
  assert.equal(mid.threshold, BASE.threshold);
  assert.equal(mid.max, BASE.max);
  assert.match(mid.note, /60\/100/);

  const none = moodTuning(undefined, BASE);
  assert.deepEqual(none, { threshold: BASE.threshold, max: BASE.max, note: '' });
});

test('阈值不会被推出 0–1', () => {
  const high = moodTuning({ value: 10, label: '低落' }, { threshold: 0.95, max: 3 });
  assert.equal(high.threshold, 1);
  const low = moodTuning({ value: 95, label: '兴奋' }, { threshold: 0.02, max: 3 });
  assert.equal(low.threshold, 0);
});
