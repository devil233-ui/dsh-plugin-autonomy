/**
 * 复盘（`src/core/review.ts`）的钉子。
 *
 * 三件事必须成立：预算真的裁掉最旧的记录、回包不像话时一定退回模板、
 * 模板只陈述记录里确实发生过的事（不替她编判断）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Intent } from '../src/core/intent.js';
import type { RunRecord } from '../src/core/run.js';
import {
  buildReviewPrompt,
  parseReviewReply,
  renderJournal,
  reviewStats,
  templateReview,
  type ReviewOutcome,
} from '../src/core/review.js';

function run(index: number, decision: 'acted' | 'no_action', reason = ''): RunRecord {
  return {
    id: `r${String(index).padStart(2, '0')}`,
    trigger: 'random',
    status: 'completed',
    startedAt: new Date(Date.UTC(2026, 10, 19, 1, index)).toISOString(),
    endedAt: new Date(Date.UTC(2026, 10, 19, 1, index, 30)).toISOString(),
    decision,
    reason,
  } as RunRecord;
}

function intent(text: string, state: Intent['state']): Intent {
  return {
    id: `i${text.length}`,
    text,
    kind: 'thought',
    state,
    version: 1,
    source: 'self',
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
  } as Intent;
}

test('review: 预算不够时先丢最旧的记录', () => {
  const runs = Array.from({ length: 30 }, (_unused, index) => run(index, 'no_action', '没有该我做的事'));
  const { prompt, clipped } = buildReviewPrompt({ runs, intents: [] }, { maxInputTokens: 400 });
  assert.ok(clipped > 0, '应当裁掉若干条');
  assert.ok(!prompt.includes('r00'), '最旧的记录应被裁掉');
  assert.ok(prompt.includes('r29'), '最新的记录必须留着');
});

test('review: 回包不是 JSON 就用模板兜底', () => {
  const fallback: ReviewOutcome = { summary: 's', lessons: [], next: 'continued', memoryDrafts: [], fromModel: false };
  assert.equal(parseReviewReply('模型只写了散文，没有 JSON', fallback), fallback);
  assert.equal(parseReviewReply('{"lessons":["x"]}', fallback), fallback);
});

test('review: 合法回包被收下，字段被裁剪', () => {
  const fallback: ReviewOutcome = { summary: 's', lessons: [], next: 'continued', memoryDrafts: [], fromModel: false };
  const parsed = parseReviewReply(
    '好的：{"summary":"这一段很安静","lessons":["- 别为交差找活","","x"],"next":"drop","memoryDrafts":["记住这句话"]}',
    fallback,
  );
  assert.equal(parsed.fromModel, true);
  assert.equal(parsed.summary, '这一段很安静');
  assert.deepEqual(parsed.lessons, ['别为交差找活']);
  assert.equal(parsed.next, 'drop');
  assert.deepEqual(parsed.memoryDrafts, ['记住这句话']);
});

test('review: 模板只写发生过的事，连着安静会点出来', () => {
  const runs = [run(1, 'no_action'), run(2, 'no_action'), run(3, 'no_action')];
  const outcome = templateReview(runs, [intent('等主人点头', 'open')]);
  assert.equal(outcome.fromModel, false);
  assert.match(outcome.summary, /自检 3 次：出手 0 次、安静 3 次/);
  assert.ok(outcome.lessons.some((line) => line.includes('一次都没出手')));
  assert.ok(outcome.lessons.some((line) => line.includes('连着几次都是安静收尾')));
});

test('review: 统计与日刊形状', () => {
  const runs = [run(1, 'acted', '补了笔记'), run(2, 'no_action')];
  const stats = reviewStats(runs, [intent('a', 'open'), intent('b', 'done')]);
  assert.deepEqual(stats, { runs: 2, acted: 1, quiet: 1, intentsSettled: 1 });
  const page = renderJournal({ at: Date.UTC(2026, 10, 19, 2), stats, outcome: templateReview(runs, []) });
  assert.match(page, /## 2026-11-19 02:00:00Z · 复盘/);
  assert.match(page, /教训：/);
  assert.match(page, /下一步：continued/);
});
