/**
 * 复盘的调度者（`src/host/reviewer.ts`）的钉子。
 *
 * 这里钉的是「什么时候跑」和「跑完落在哪」：门槛没到不许惊动模型、状态没
 * 落定不许跑、跑完必须写日刊并把 `lastReviewAt` 推上去；模型抛错时仍然要
 * 留下一份模板复盘，而不是什么都不写。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Reviewer } from '../src/host/reviewer.js';
import { DEFAULT_CONFIG, type AutonomyConfig } from '../src/host/settings.js';
import { StateStore } from '../src/host/state.js';

const ROOM = 'session-room';
const NOW = Date.UTC(2026, 10, 19, 3, 0, 0);

function withStore(body: (store: StateStore, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'autonomy-review-'));
  const store = new StateStore(dir, 20, 50);
  return body(store, dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function seed(store: StateStore, count: number, status: 'completed' | 'settling' = 'completed'): void {
  store.update(
    ROOM,
    (session) => {
      session.runs = Array.from({ length: count }, (_unused, index) => ({
        id: `r${index}`,
        trigger: 'random',
        status,
        startedAt: new Date(NOW - (count - index) * 60_000).toISOString(),
        decision: 'no_action',
        reason: '没有该我做的事',
      })) as never;
    },
    NOW,
  );
}

function config(patch: Partial<AutonomyConfig> = {}): AutonomyConfig {
  return { ...DEFAULT_CONFIG, wakeSession: ROOM, reviewEnabled: true, reviewBatch: 3, reviewMinGapMinutes: 0, ...patch };
}

test('reviewer: 门槛没到就不惊动模型', async () => {
  await withStore(async (store) => {
    seed(store, 2);
    let called = 0;
    const reviewer = new Reviewer({
      config: () => config(),
      state: store,
      dataDir: join(tmpdir(), 'never'),
      now: () => NOW,
      log: { warn: () => {} },
      runTurn: async () => {
        called += 1;
        return '{}';
      },
    });
    await reviewer.maybeReview();
    assert.equal(called, 0);
  });
});

test('reviewer: 有在飞判断时先不跑', async () => {
  await withStore(async (store) => {
    seed(store, 3, 'settling');
    let called = 0;
    const reviewer = new Reviewer({
      config: () => config(),
      state: store,
      dataDir: join(tmpdir(), 'never'),
      now: () => NOW,
      log: { warn: () => {} },
      runTurn: async () => {
        called += 1;
        return '{}';
      },
    });
    await reviewer.maybeReview();
    assert.equal(called, 0);
  });
});

test('reviewer: 到点就跑，日刊落盘、记忆写入、水位推进', async () => {
  await withStore(async (store, dir) => {
    seed(store, 3);
    const remembered: string[] = [];
    const reviewer = new Reviewer({
      config: () => config(),
      state: store,
      dataDir: dir,
      now: () => NOW,
      log: { warn: () => {} },
      runTurn: async () => JSON.stringify({ summary: '这一段很安静', lessons: ['别为交差找活'], next: 'continued', memoryDrafts: ['安静也是一种判断'] }),
      remember: (text) => {
        remembered.push(text);
      },
    });
    await reviewer.maybeReview();
    const journal = join(dir, 'journal', '2026-11-19.md');
    assert.ok(existsSync(journal), '日刊应当写出来');
    const page = readFileSync(journal, 'utf8');
    assert.match(page, /这一段很安静/);
    assert.match(page, /别为交差找活/);
    assert.deepEqual(remembered, ['安静也是一种判断']);
    assert.equal(store.session(ROOM)?.lastReviewAt, NOW);
  });
});

test('reviewer: 模型抛错也留一份模板复盘', async () => {
  await withStore(async (store, dir) => {
    seed(store, 3);
    const reviewer = new Reviewer({
      config: () => config(),
      state: store,
      dataDir: dir,
      now: () => NOW,
      log: { warn: () => {} },
      runTurn: async () => {
        throw new Error('hub 没接线');
      },
    });
    await reviewer.maybeReview();
    const page = readFileSync(join(dir, 'journal', '2026-11-19.md'), 'utf8');
    assert.match(page, /模板兜底/);
    assert.equal(store.session(ROOM)?.lastReviewAt, NOW);
  });
});
