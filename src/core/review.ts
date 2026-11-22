/**
 * 复盘（review round）。
 *
 * 判断的记录本来就在台账里躺着，但它们只是流水：这一次为什么没动、那一次
 * 为什么出手，攒着不会自己变成经验。复盘就是把这些记录在**够数的时候**交给
 * 一个不占任何会话的回合去蒸馏，产出「教训 / 下次还做吗 / 值得记住的话」。
 *
 * 这一层只做纯函数：拼输入、按 token 预算裁、解析回包、渲染日刊。她不答
 * 或答歪了就退回确定性模板——复盘失败不该把她的判断一起丢掉。
 */

import type { Intent } from './intent.js';
import type { RunRecord } from './run.js';

/** v5 同口径：中文按 2 字符≈1 token 粗估，只用于预算裁剪。 */
export function estimateTokens(value: unknown): number {
  return Math.ceil(String(value ?? '').length / 2);
}

export const DEFAULT_REVIEW_INPUT_TOKENS = 4 * 1024;
export const DEFAULT_REVIEW_OUTPUT_TOKENS = 512;

export type ReviewNext = 'retry' | 'drop' | 'promote' | 'archive' | 'continued';

export interface ReviewOutcome {
  summary: string;
  lessons: string[];
  next: ReviewNext;
  memoryDrafts: string[];
  /** 回包没解析成功时为 false，产出来自确定性模板。 */
  fromModel: boolean;
}

export interface ReviewStats {
  runs: number;
  acted: number;
  quiet: number;
  intentsSettled: number;
}

export function reviewStats(runs: readonly RunRecord[], intents: readonly Intent[]): ReviewStats {
  return {
    runs: runs.length,
    acted: runs.filter((run) => (run.decision ?? '') === 'acted').length,
    quiet: runs.filter((run) => (run.decision ?? '') === 'no_action').length,
    intentsSettled: intents.filter((intent) => intent.state !== 'open').length,
  };
}

/**
 * 拼复盘输入。记录多了就从**最旧的**开始丢——复盘要看的是刚过去这一段，
 * 不是把一天的流水整本塞进去。
 */
export function buildReviewPrompt(
  input: { runs: readonly RunRecord[]; intents: readonly Intent[] },
  options: { maxInputTokens?: number; batchLabel?: string } = {},
): { prompt: string; clipped: number } {
  const maxInput = options.maxInputTokens ?? DEFAULT_REVIEW_INPUT_TOKENS;
  const runs = [...input.runs];
  const lines: string[] = [];
  const head = [
    '复盘你刚过去的这一段自检。要说的是：我做了什么、为什么、下次还做吗、学会了什么。',
    '- 按真实记录说话，no_action 也照实写，不用给自己找活干。',
    '- 只输出 JSON：{"summary":"…","lessons":["…"],"next":"retry|drop|promote|archive|continued","memoryDrafts":["…"]}',
    '- lessons 与 memoryDrafts 各 0~3 条，一条一句，别写流水账。',
    '',
    options.batchLabel === undefined ? '这一段的自检记录：' : options.batchLabel,
  ];
  let clipped = 0;
  const render = (): string[] => {
    const body: string[] = [];
    for (const run of runs) {
      const when = new Date(run.startedAt).toISOString().slice(11, 16);
      const decision = run.decision ?? run.status;
      const reason = (run.reason ?? '').trim();
      body.push(`- ${when} #${run.id} [${run.trigger}] ${decision}${reason === '' ? '' : `：${reason}`}`);
    }
    const settled = input.intents.filter((intent) => intent.state !== 'open').slice(-6);
    for (const intent of settled) {
      body.push(`- 意图「${intent.text.slice(0, 80)}」→ ${intent.state}${intent.reason ? `（${intent.reason}）` : ''}`);
    }
    return body;
  };
  for (;;) {
    const body = render();
    const prompt = [...head, ...body].join('\n');
    if (estimateTokens(prompt) <= maxInput || runs.length === 0) return { prompt, clipped };
    runs.shift();
    clipped += 1;
  }
}

/** 解析回包；不是合法 JSON、或字段不像话，就认输交给模板。 */
export function parseReviewReply(raw: string, fallback: ReviewOutcome): ReviewOutcome {
  const text = String(raw ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return fallback;
  }
  if (typeof parsed !== 'object' || parsed === null) return fallback;
  const record = parsed as Record<string, unknown>;
  const summary = typeof record['summary'] === 'string' ? record['summary'].trim() : '';
  if (summary === '') return fallback;
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.replace(/^[-*\d.、\s]+/, '').trim())
          .filter((entry) => entry.length >= 2)
          .slice(0, 3)
      : [];
  const nextRaw = typeof record['next'] === 'string' ? record['next'].trim() : '';
  const next: ReviewNext =
    nextRaw === 'retry' || nextRaw === 'drop' || nextRaw === 'promote' || nextRaw === 'archive'
      ? nextRaw
      : 'continued';
  return { summary, lessons: strings(record['lessons']), next, memoryDrafts: strings(record['memoryDrafts']), fromModel: true };
}

/** 她没答上来时的产出：只陈述记录里确实发生的事，不替她编判断。 */
export function templateReview(runs: readonly RunRecord[], intents: readonly Intent[]): ReviewOutcome {
  const stats = reviewStats(runs, intents);
  const lessons: string[] = [];
  const acted = runs.filter((run) => (run.decision ?? '') === 'acted' && (run.reason ?? '').trim() !== '');
  for (const run of acted.slice(-2)) lessons.push(`出手那次：${(run.reason ?? '').trim().slice(0, 60)}`);
  if (stats.runs > 0 && stats.acted === 0) lessons.push('这一段一次都没出手——没有值得动的事，就不算失职');
  if (stats.runs >= 3 && stats.quiet === stats.runs) lessons.push('连着几次都是安静收尾：下次开局先问「真有该我做的事吗」，别为了交差找活');
  const summary =
    stats.runs === 0
      ? '这一段没有自检记录，没什么可复盘的。'
      : `这一段自检 ${stats.runs} 次：出手 ${stats.acted} 次、安静 ${stats.quiet} 次。`;
  return { summary, lessons: lessons.slice(0, 3), next: 'continued', memoryDrafts: [], fromModel: false };
}

export function renderJournal(entry: {
  at: number;
  stats: ReviewStats;
  outcome: ReviewOutcome;
}): string {
  const stamp = new Date(entry.at).toISOString().replace('T', ' ').slice(0, 19);
  const lines = [
    `## ${stamp}Z · 复盘`,
    '',
    entry.outcome.summary,
    '',
    `记录：自检 ${entry.stats.runs} 次（出手 ${entry.stats.acted} / 安静 ${entry.stats.quiet}），收尾意图 ${entry.stats.intentsSettled} 条。${entry.outcome.fromModel ? '' : '（回包没解析成功，用模板兜底）'}`,
  ];
  if (entry.outcome.lessons.length > 0) {
    lines.push('', '教训：', ...entry.outcome.lessons.map((lesson) => `- ${lesson}`));
  }
  if (entry.outcome.memoryDrafts.length > 0) {
    lines.push('', '值得记住：', ...entry.outcome.memoryDrafts.map((draft) => `- ${draft}`));
  }
  lines.push('', `下一步：${entry.outcome.next}`, '');
  return lines.join('\n');
}
