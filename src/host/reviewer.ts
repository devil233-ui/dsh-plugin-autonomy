/**
 * 复盘的调度者：什么时候值得蒸馏、把记录变成日刊、把值得记的写进记忆。
 *
 * 触发门槛刻意保守——攒够 `reviewBatch` 条判断、且距上次复盘至少
 * `reviewMinGapMinutes` 分钟，就够一次；它**不碰唤醒节奏**，既不改下次掷骰
 * 时间，也不占用任何聊天会话（走 dsh-aurabot-qq 的系统回合，没有就走模板）。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildReviewPrompt,
  parseReviewReply,
  renderJournal,
  reviewStats,
  templateReview,
  type ReviewOutcome,
} from '../core/review.js';
import type { AutonomyConfig } from './settings.js';
import type { StateStore } from './state.js';

export interface ReviewerDeps {
  config(): AutonomyConfig;
  state: StateStore;
  dataDir: string;
  now(): number;
  log: { warn(message: string): void; info?(message: string): void };
  /** 跑一轮不带工具的复盘回合；没接线（没装 dsh-aurabot-qq）时退回模板。 */
  runTurn?(prompt: string, options: { timeoutMs: number }): Promise<string>;
  /** 把值得记的话写进长期记忆；失败只记日志。 */
  remember?(text: string): Promise<unknown> | unknown;
}

export const REVIEW_TIMEOUT_MS = 60_000;

export class Reviewer {
  readonly #deps: ReviewerDeps;

  constructor(deps: ReviewerDeps) {
    this.#deps = deps;
  }

  async maybeReview(): Promise<void> {
    const config = this.#deps.config();
    if (!config.reviewEnabled) return;
    const room = config.wakeSession.trim();
    if (room === '') return;
    const state = this.#deps.state.session(room);
    if (state === undefined) return;
    const now = this.#deps.now();
    const since = state.lastReviewAt ?? 0;
    const recent = state.runs.filter((run) => Date.parse(run.startedAt) > since);
    if (recent.length < Math.max(1, config.reviewBatch)) return;
    if (recent.some((run) => run.status === 'queued' || run.status === 'running' || run.status === 'settling')) return;
    if (since !== 0 && now - since < Math.max(0, config.reviewMinGapMinutes) * 60_000) return;

    const fallback = templateReview(recent, state.intents);
    let outcome: ReviewOutcome = fallback;
    if (this.#deps.runTurn !== undefined) {
      const { prompt } = buildReviewPrompt(
        { runs: recent, intents: state.intents },
        { maxInputTokens: config.reviewMaxInputTokens },
      );
      try {
        const raw = await this.#deps.runTurn(prompt, { timeoutMs: REVIEW_TIMEOUT_MS });
        outcome = parseReviewReply(raw, fallback);
      } catch (error) {
        this.#deps.log.warn(`[autonomy] review turn failed, using template (${String(error)})`);
      }
    }

    const stats = reviewStats(recent, state.intents);
    const entry = renderJournal({ at: now, stats, outcome });
    try {
      const dir = join(this.#deps.dataDir, 'journal');
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, `${new Date(now).toISOString().slice(0, 10)}.md`), entry, 'utf8');
    } catch (error) {
      this.#deps.log.warn(`[autonomy] review journal write failed (${String(error)})`);
    }

    if (this.#deps.remember !== undefined && outcome.memoryDrafts.length > 0) {
      for (const draft of outcome.memoryDrafts.slice(0, 3)) {
        try {
          const refused = await this.#deps.remember(draft);
          if (typeof refused === 'string' && refused !== '') {
            this.#deps.log.warn(`[autonomy] review memory not written: ${refused}`);
          }
        } catch (error) {
          this.#deps.log.warn(`[autonomy] review memory write failed (${String(error)})`);
        }
      }
    }

    this.#deps.state.update(
      room,
      (session) => {
        session.lastReviewAt = now;
      },
      now,
    );
    this.#deps.log.info?.(`[autonomy] review done: ${stats.runs} runs, ${outcome.lessons.length} lessons, model=${outcome.fromModel}`);
  }
}
