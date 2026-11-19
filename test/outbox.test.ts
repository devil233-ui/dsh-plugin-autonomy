/**
 * 待发队列（`src/core/outbox.ts`）的钉子。
 *
 * 排队的价值全在「不丢、但绝不晚发」这两端的边界上，所以这里只钉四件事：
 * 过期作废、待发不被裁剪挤掉、状态迁移、以及长文截断。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_OUTBOX,
  MAX_OUTBOX_TEXT,
  enqueueOutbox,
  markOutbox,
  pendingItems,
  sweepExpired,
  trimOutbox,
  type OutboxItem,
} from '../src/core/outbox.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function item(id: string, overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id,
    target: 'group:1053858006',
    text: `text ${id}`,
    createdAt: NOW,
    expiresAt: NOW + 10 * MIN,
    status: 'pending',
    ...overrides,
  };
}

test('outbox: 排队带过期时间，状态是 pending', () => {
  const items = enqueueOutbox([], { id: 'o1', target: '', text: 'hi', now: NOW, ttlMs: 5 * MIN });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.status, 'pending');
  assert.equal(items[0]?.expiresAt, NOW + 5 * MIN);
  assert.equal(items[0]?.target, '');
});

test('outbox: 过期后作废，已发的保持不变', () => {
  const items = [item('a'), item('b', { status: 'sent', note: 'sent' })];
  const swept = sweepExpired(items, NOW + 11 * MIN);
  assert.equal(swept[0]?.status, 'expired');
  assert.match(swept[0]?.note ?? '', /expired/);
  assert.equal(swept[1]?.status, 'sent');
});

test('outbox: 超上限时先丢已收尾的，待发的一条都不动', () => {
  const settled = Array.from({ length: MAX_OUTBOX }, (_unused, index) =>
    item(`s${index}`, { status: 'sent', createdAt: NOW + index }),
  );
  const pending = [item('p1', { createdAt: NOW + 100 })];
  const trimmed = trimOutbox([...settled, ...pending]);
  assert.equal(trimmed.length, MAX_OUTBOX);
  assert.deepEqual(pendingItems(trimmed).map((entry) => entry.id), ['p1']);
});

test('outbox: 状态迁移只改指定那条', () => {
  const items = [item('a'), item('b')];
  const marked = markOutbox(items, 'a', 'failed', 'bridge said no');
  assert.equal(marked[0]?.status, 'failed');
  assert.equal(marked[0]?.note, 'bridge said no');
  assert.equal(marked[1]?.status, 'pending');
});

test('outbox: 正文超长截断，不整条拒收', () => {
  const items = enqueueOutbox([], {
    id: 'long',
    target: 'group:1',
    text: 'x'.repeat(MAX_OUTBOX_TEXT + 500),
    now: NOW,
    ttlMs: MIN,
  });
  assert.equal(items[0]?.text.length, MAX_OUTBOX_TEXT);
});
