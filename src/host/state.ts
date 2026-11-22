/**
 * Per-session autonomy state, persisted as one JSON document.
 *
 * One file for the whole host keeps the read path simple (`state()` must be
 * cheap because the panel polls it) and keeps a session's intents, run
 * history, and roll schedule together, so a crash never leaves a wake
 * recorded against a session that has lost its intent list.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Intent } from '../core/intent.js';
import { trimIntents } from '../core/intent.js';
import type { OutboxItem } from '../core/outbox.js';
import { trimOutbox } from '../core/outbox.js';
import type { RunRecord } from '../core/run.js';
import { trimRuns } from '../core/run.js';

export const STATE_VERSION = 1;

/** A wake the model asked for itself (whalelife's `self_wake`). */
export interface SelfWake {
  /** Epoch milliseconds. */
  at: number;
  /** Why the model scheduled it; carried into the framing text. */
  note?: string;
}

export interface SessionState {
  sessionId: string;
  /** Last time this session saw real activity (user message or a run). */
  lastActivityAt: number;
  /** When the next dice roll is due. */
  nextCheckAt: number;
  selfWake?: SelfWake;
  /**
   * The most recent self-scheduled wake that actually fired. Kept only so the
   * panel can still say "she scheduled this herself" after the pending entry is
   * consumed; scheduling itself always reads `selfWake`.
   */
  lastSelfWake?: SelfWake & { firedAt: number };
  intents: Intent[];
  runs: RunRecord[];
  /**
   * 排队等她说话的目标空下来再投的消息（`autonomy_say` 的 when_free）。
   * 可选：老状态文件里没有这一栏，读出来按空队列处理，不为此升版本号。
   */
  outbox?: OutboxItem[];
  /** 上次复盘的时间（epoch ms）；没有这一栏 = 还没复盘过。 */
  lastReviewAt?: number;
  /**
   * Recently applied autonomy_schedule requestIds (newest last, capped).
   * Re-sending the same request must not reschedule anything (whalelife's
   * requestId idempotency), and a restart must not replay it either.
   */
  seenRequests?: string[];
  /** Bumped on every accepted schedule change; stale versions are refused. */
  selfWakeVersion?: number;
  /** Local date (`YYYY-MM-DD`) the daily counter belongs to. */
  counterDay?: string;
  counterRuns: number;
}

export const MAX_SEEN_REQUESTS = 32;

export interface AutonomyState {
  version: number;
  sessions: Record<string, SessionState>;
}

export function emptyState(): AutonomyState {
  return { version: STATE_VERSION, sessions: {} };
}

export function emptySession(sessionId: string, nextCheckAt: number): SessionState {
  return {
    sessionId,
    lastActivityAt: 0,
    nextCheckAt,
    intents: [],
    runs: [],
    outbox: [],
    counterRuns: 0,
  };
}

/** Days are counted in local wall-clock time, matching the panel's labels. */
export function localDay(epoch: number): string {
  const date = new Date(epoch);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export class StateStore {
  readonly #file: string;
  #state: AutonomyState;
  #maxRuns: number;
  #maxIntents: number;

  constructor(dataDir: string, maxRuns: number, maxIntents: number) {
    this.#file = join(dataDir, 'state.json');
    this.#maxRuns = maxRuns;
    this.#maxIntents = maxIntents;
    this.#state = this.#read();
  }

  #read(): AutonomyState {
    let text: string;
    try {
      text = readFileSync(this.#file, 'utf8');
    } catch {
      return emptyState();
    }
    try {
      const parsed = JSON.parse(text) as Partial<AutonomyState>;
      if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
        return { version: STATE_VERSION, sessions: parsed.sessions as Record<string, SessionState> };
      }
    } catch {
      /* a corrupt file is rebuilt from scratch on the next write */
    }
    return emptyState();
  }

  /** Write through a temp file so a crash cannot truncate the live state. */
  flush(): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    const temp = `${this.#file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.#state, null, 2), 'utf8');
    renameSync(temp, this.#file);
  }

  state(): AutonomyState {
    return this.#state;
  }

  /** Every session that has ever been recorded, live or cold. */
  sessionIds(): string[] {
    return Object.keys(this.#state.sessions);
  }

  session(sessionId: string, createWith?: number): SessionState | undefined {
    const existing = this.#state.sessions[sessionId];
    if (existing !== undefined) return existing;
    if (createWith === undefined) return undefined;
    const created = emptySession(sessionId, createWith);
    this.#state.sessions[sessionId] = created;
    return created;
  }

  /** Apply one mutation, trim its lists, and persist. */
  update(sessionId: string, mutate: (state: SessionState) => void, createWith?: number): SessionState | undefined {
    const session = this.session(sessionId, createWith);
    if (session === undefined) return undefined;
    mutate(session);
    session.intents = trimIntents(session.intents, this.#maxIntents);
    session.outbox = trimOutbox(session.outbox ?? []);
    session.runs = trimRuns(session.runs, this.#maxRuns);
    this.flush();
    return session;
  }

  setLimits(maxRuns: number, maxIntents: number): void {
    this.#maxRuns = maxRuns;
    this.#maxIntents = maxIntents;
  }

  /** Drop state for sessions the operator no longer supervises. */
  prune(keep: Set<string>): void {
    let changed = false;
    for (const id of Object.keys(this.#state.sessions)) {
      if (!keep.has(id)) {
        delete this.#state.sessions[id];
        changed = true;
      }
    }
    if (changed) this.flush();
  }
}
