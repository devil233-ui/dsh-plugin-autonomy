/**
 * 愿望（`src/core/wish.ts`）的钉子。
 *
 * 这里只钉三件事：去重键忽略空白标点、短句不被误判成重复、超限时丢最旧的。
 * 愿望不参与打分也不进台账，所以这一层不需要更多。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_WISH_TEXT, sameWish, trimWishes, trimWishText, wishKey, type Wish } from '../src/core/wish.js';

function wish(id: string, text: string): Wish {
  return { id, text, day: '2026-11-22', source: '/tmp/2026-11-22.md', addedAt: '2026-11-22T15:00:00.000Z' };
}

test('wishKey 忽略大小写、空白与常见标点', () => {
  assert.equal(wishKey(' 房子里 养只猫。'), wishKey('房子里养只猫'));
  assert.equal(wishKey('ＡＢＣ'), wishKey('abc'));
});

test('sameWish：一方包含另一方（短句≥6 字）算同一条', () => {
  assert.equal(sameWish('房子里养只猫，把窗边那盏灯打开', '房子里养只猫'), true);
  assert.equal(sameWish('猫', '房子里养只猫'), false);
  assert.equal(sameWish('', '房子里养只猫'), false);
});

test('trimWishText 超长截断并留省略号', () => {
  const long = '愿'.repeat(MAX_WISH_TEXT + 10);
  const trimmed = trimWishText(long);
  assert.equal(trimmed.endsWith('…'), true);
  assert.equal(trimmed.length, MAX_WISH_TEXT + 1);
});

test('trimWishes 超限时丢最旧的', () => {
  const list = [wish('a', '一'), wish('b', '二'), wish('c', '三')];
  const kept = trimWishes(list, 2);
  assert.deepEqual(kept.map((row) => row.id), ['b', 'c']);
});
