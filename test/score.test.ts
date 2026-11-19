/**
 * 打分（`src/core/score.ts`）的钉子。
 *
 * 这一层的价值在于「可复算」：同样的状态与时钟必须得到同样的分数，
 * 所以这里逐项钉住 urgency / novelty / 排序 / 门槛，而不是只测一个用例。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  commitmentOf,
  explain,
  fingerprint,
  noveltyOf,
  overlap,
  rankCandidates,
  relevanceOf,
  selectCandidates,
  urgencyOf,
  type Candidate,
} from '../src/core/score.js';

const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const HOUR = 3_600_000;

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

test('score-urgency：迟到 1，一天内 0.75，远期 0.3，只看 preferredAt 时降一档', () => {
  assert.equal(urgencyOf({ id: 'a', text: 't', kind: 'thought', dueAt: at(-HOUR) }, NOW), 1);
  assert.equal(urgencyOf({ id: 'a', text: 't', kind: 'thought', dueAt: at(3 * HOUR) }, NOW), 0.75);
  assert.equal(urgencyOf({ id: 'a', text: 't', kind: 'thought', dueAt: at(72 * HOUR) }, NOW), 0.3);
  assert.equal(urgencyOf({ id: 'a', text: 't', kind: 'thought', preferredAt: at(-HOUR) }, NOW), 0.6);
  assert.equal(urgencyOf({ id: 'a', text: 't', kind: 'thought', preferredAt: at(72 * HOUR) }, NOW), 0.25);
  assert.equal(urgencyOf({ id: 'a', text: 't', kind: 'thought' }, NOW), 0.2);
  // dueAt 优先于 preferredAt：两者都给时按时限算。
  const both = { id: 'a', text: 't', kind: 'thought' as const, dueAt: at(-HOUR), preferredAt: at(72 * HOUR) };
  assert.equal(urgencyOf(both, NOW), 1);
});

test('score-novelty：重复的旧事得 0，全新的事得 1，指纹只认内容不认空白标点', () => {
  assert.equal(noveltyOf('补 manners 的路径规则', []), 1);
  assert.equal(noveltyOf('补 manners 的路径规则', ['补 manners 的路径规则']), 0);
  assert.equal(fingerprint('补 manners 的路径规则'), fingerprint('补  manners 的路径规则。'));
  assert.notEqual(fingerprint('补 manners 的路径规则'), fingerprint('补 manners 的哈希规则'));
  assert.ok(overlap('明天补剧透群二创', '补剧透群二创的评论') > 0.3);
  // 空输入不炸，也不假装相似。
  assert.equal(noveltyOf('', ['']), 1);
});

test('score-rank：到期且未说过的承诺排在无期限的念头前面，同分按期限再按 id', () => {
  const candidates: Candidate[] = [
    { id: 'b2', text: '等主人点头再改 collect 技能', kind: 'thought' },
    { id: 'b1', text: '把二创补发到剧透群', kind: 'agreement', dueAt: at(-2 * HOUR) },
    { id: 'b3', text: '以后可以研究一下票圈排版', kind: 'thought', preferredAt: at(72 * HOUR) },
  ];
  const ranked = rankCandidates(candidates, { now: NOW, recent: ['等主人点头再改 collect 技能'] });
  assert.equal(ranked[0]?.id, 'b1');
  assert.equal(ranked[2]?.id, 'b2', '重复的旧念头应当掉到后面');
  assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0));
});

test('score-select：门槛以下的留在台账不进提示，条数受上限约束，排序不被打乱', () => {
  const ranked = rankCandidates(
    [
      { id: 'x1', text: '甲', kind: 'agreement', dueAt: at(-HOUR) },
      { id: 'x2', text: '乙', kind: 'agreement', dueAt: at(2 * HOUR) },
      { id: 'x3', text: '丙', kind: 'thought', preferredAt: at(48 * HOUR) },
      { id: 'x4', text: '丁', kind: 'thought' },
    ],
    { now: NOW, recent: [] },
  );
  const kept = selectCandidates(ranked, { threshold: 0.5, max: 2 });
  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map((entry) => entry.id), ['x1', 'x2']);
  assert.equal(selectCandidates(ranked, { threshold: 0.99, max: 2 }).length, 0);
  assert.equal(selectCandidates(ranked, { threshold: 0, max: 0 }).length, 0);
});

test('score-explain：理由说清是迟到、是新、还是旧事重提', () => {
  const late = rankCandidates(
    [{ id: 'e1', text: '补发二创', kind: 'agreement', dueAt: at(-3 * HOUR) }],
    { now: NOW, recent: [] },
  )[0];
  assert.ok(late !== undefined);
  assert.match(explain(late, NOW), /overdue by 3h/);
  assert.match(explain(late, NOW), /new/);
  assert.match(explain(late, NOW), /a promise/);

  const stale = rankCandidates(
    [{ id: 'e2', text: '补发二创', kind: 'thought' }],
    { now: NOW, recent: ['补发二创'] },
  )[0];
  assert.ok(stale !== undefined);
  assert.match(explain(stale, NOW), /close to something already handled/);
  assert.match(explain(stale, NOW), /no deadline/);
});

test('score-provenance：主人说的比她自己记的更重，承诺比念头更重', () => {
  assert.ok(relevanceOf('owner') > relevanceOf('self'));
  assert.ok(relevanceOf('conversation') > relevanceOf('self'));
  assert.ok(commitmentOf('agreement') > commitmentOf('self'));
  assert.ok(commitmentOf('self') > commitmentOf('thought'));
});
