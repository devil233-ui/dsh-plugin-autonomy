/**
 * 记忆召回的钉子：召回失败与「没命中」都必须退化成空字符串（这轮就当没记忆），
 * 但真正出错时要留一行 warn，别再像写记忆那次一样把失败吞掉。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatRecall, recallQuery } from '../src/core/recall.js';
import { MemoryRecall } from '../src/host/recall.js';

test('recall: 只认 success + count>0，其余一律空', () => {
  assert.equal(formatRecall({ success: true, count: 2, formatted: '甲\n乙' }, 100), '甲\n乙');
  assert.equal(formatRecall({ success: false, count: 2, formatted: '甲' }, 100), '');
  assert.equal(formatRecall({ success: true, count: 0, formatted: '' }, 100), '');
  assert.equal(formatRecall(null, 100), '');
});

test('recall: 按预算截断', () => {
  assert.equal(formatRecall({ success: true, count: 1, formatted: '一二三四五六七八九十' }, 4), '一二三四');
});

test('recall: 查询句用候选、没有候选退回台账', () => {
  assert.equal(recallQuery({ candidates: [{ text: '补发剧透群' }] }), '补发剧透群');
  assert.equal(recallQuery({ openIntents: [{ text: '甲' }, { text: '乙' }] }), '甲；乙');
  assert.equal(recallQuery({ openIntents: [] }), '');
  assert.equal(recallQuery({ openIntents: [], note: '随机抽查' }), '随机抽查');
});

test('recall: 客户端把结果交给 formatRecall，HTTP 失败返回空并告警', async () => {
  const warns: string[] = [];
  const make = (impl: typeof fetch) =>
    new MemoryRecall({
      url: () => 'http://127.0.0.1:3100/api/recall',
      limit: () => 4,
      timeoutMs: () => 500,
      maxChars: () => 100,
      log: { warn: (message) => warns.push(message) },
      fetchImpl: impl,
    });

  const ok = make((async () =>
    new Response(JSON.stringify({ success: true, count: 1, formatted: '她记着她答应过的事' }), { status: 200 })) as typeof fetch);
  assert.equal(await ok.recall('答应'), '她记着她答应过的事');

  const bad = make((async () => new Response('nope', { status: 502 })) as typeof fetch);
  assert.equal(await bad.recall('答应'), '');
  assert.equal(warns.length, 1);
  assert.match(warns[0] as string, /recall HTTP 502/);
});
