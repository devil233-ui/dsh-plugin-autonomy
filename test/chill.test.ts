/**
 * 冷度与暂停的钉子：连着几轮开到眼前却没动手 → 停七天；真动手了 → 清零；
 * 暂停到期以后从半格重新数，不能刚解冻就又关进去。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHILL_PARK_AT, PARK_MS, createIntent, isParked, recordHit, recordMiss } from '../src/core/intent.js';

const NOW = new Date('2026-11-20T02:00:00.000Z');

function fresh() {
  const made = createIntent({ text: '把下午那篇补发到剧透群', kind: 'thought' }, NOW, () => 'i1');
  assert.ok(made.ok);
  return made.value;
}

test('chill: 没动手三次还不至于暂停', () => {
  let intent = fresh();
  for (let i = 0; i < 3; i += 1) intent = recordMiss(intent, NOW);
  assert.equal(intent.chill, 1.5);
  assert.equal(intent.parkedUntil, undefined);
  assert.equal(isParked(intent, NOW.getTime()), false);
});

test('chill: 第四格到顶就停七天', () => {
  let intent = fresh();
  for (let i = 0; i < 4; i += 1) intent = recordMiss(intent, NOW);
  assert.ok(intent.chill !== undefined && intent.chill >= CHILL_PARK_AT);
  assert.equal(Date.parse(intent.parkedUntil as string), NOW.getTime() + PARK_MS);
  assert.equal(isParked(intent, NOW.getTime()), true);
});

test('chill: 真动了手就清零并解除暂停', () => {
  let intent = fresh();
  for (let i = 0; i < 4; i += 1) intent = recordMiss(intent, NOW);
  const after = recordHit(intent, NOW);
  assert.equal(after.chill, undefined);
  assert.equal(after.parkedUntil, undefined);
  assert.equal(isParked(after, NOW.getTime()), false);
});

test('chill: 暂停到期从半格重新数，不会立刻再关', () => {
  let intent = fresh();
  for (let i = 0; i < 4; i += 1) intent = recordMiss(intent, NOW);
  const later = new Date(NOW.getTime() + PARK_MS + 60_000);
  assert.equal(isParked(intent, later.getTime()), false);
  const again = recordMiss(intent, later);
  assert.equal(again.chill, 0.5);
  assert.equal(again.parkedUntil, undefined);
});
