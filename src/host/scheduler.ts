/**
 * The rhythm. This is the part that makes the plugin "autonomy" rather than
 * "reminders": the host rolls the dice on a jittered interval, the model only
 * decides what to do once the roll succeeds.
 *
 * The loop is a 15-second sweep over per-session due times rather than one
 * long `setTimeout` per session, so a config change or a manual trigger takes
 * effect immediately and a missed timer cannot silently stop the plugin.
 */

import { randomUUID } from 'node:crypto';

import type { Intent } from '../core/intent.js';
import { isOpen, isOverdue, isParked, recordHit, recordMiss } from '../core/intent.js';
import {
  isSleepingAt,
  minutesOfDay,
  nextWaitMs,
  parseSleepWindows,
  wakeProbability,
  type SleepWindow,
} from '../core/schedule.js';
import type { RunRecord, RunTrigger } from '../core/run.js';
import { explain, fingerprint, rankCandidates, selectCandidates, type Candidate } from '../core/score.js';
import { createRun, isTerminal, markInterrupted, markSettling, settleRun, startRun } from '../core/run.js';
import { localDay, type StateStore } from './state.js';
import { lastActivityEpoch } from './observer.js';
import { sessionLogOf, type AgentsFacade } from './types.js';
import type { AutonomyConfig } from './settings.js';
import type { WakeDriver, WakeOutcome, WakeRequest } from './wake.js';

export interface SchedulerDeps {
  config(): AutonomyConfig;
  state: StateStore;
  driver: WakeDriver;
  agents: AgentsFacade;
  timeZone: string;
  logger: { warn(message: string): void; info?(message: string): void };
  /** Notified after every judgement so the panel can refresh. */
  onChange?: () => void;
  /**
   * 投递排队的发言（`autonomy_say` 的 when_free）。每轮扫描先跑它：这一步与
   * 掷骰无关，谁都不该因为它而被提前唤醒。
   */
  drainOutbox?: () => Promise<void>;
  /** 够数就复盘一次；与掷骰无关，不改任何会话的唤醒时间。 */
  review?: () => Promise<void>;
}

const SWEEP_MS = 15_000;

/** How many scored intents the framing gets; the rest stay listed but unranked. */
const MAX_RANKED = 3;

function newRunId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

export class Scheduler {
  readonly #deps: SchedulerDeps;
  #timer: NodeJS.Timeout | undefined;
  #ticking = false;
  #started = false;
  #stopped = false;
  #windowsCache: { raw: string; windows: SleepWindow[] } | undefined;

  constructor(deps: SchedulerDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.recoverInterrupted();
    this.#stopped = false;
    this.#timer = setInterval(() => {
      void this.tick();
    }, SWEEP_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  get running(): boolean {
    return this.#started && !this.#stopped;
  }

  /**
   * Sessions this host supervises: the wake room when one is configured, else
   * the configured list, else every live root agent. The wake room wins
   * because it is the one place an autonomous turn is guaranteed to keep the
   * local toolset (chat sessions can be gated down to a guest whitelist).
   */
  managedSessions(): string[] {
    const config = this.#deps.config();
    if (config.wakeSession !== '') return [config.wakeSession];
    if (config.sessions.length > 0) return [...config.sessions];
    try {
      return this.#deps.agents.roots().map((agent) => String(agent.id));
    } catch {
      return [];
    }
  }

  #now(): number {
    return Date.now();
  }

  /** Effective zone: the configured one when set, else the host's. */
  #timeZone(config: AutonomyConfig): string {
    return config.timezone !== '' ? config.timezone : this.#deps.timeZone;
  }

  /**
   * A run that was `running` or `settling` when the host went down is judged
   * interrupted and never replayed — same contract as whalelife's recovery.
   */
  recoverInterrupted(now = this.#now()): number {
    let touched = 0;
    for (const sessionId of this.#deps.state.sessionIds()) {
      this.#deps.state.update(sessionId, (state) => {
        state.runs = state.runs.map((run) => {
          if (isTerminal(run.status)) return run;
          if (run.status !== 'running' && run.status !== 'settling') return run;
          touched += 1;
          return markInterrupted(run, 'host restarted while this judgement was in flight', new Date(now));
        });
      }, now);
    }
    if (touched > 0) this.#deps.logger.warn(`dsh-autonomy: marked ${touched} in-flight judgement(s) as interrupted`);
    return touched;
  }

  /** Flip a live run to `settling` while its verdict is still unknown. */
  markSettling(sessionId: string, runId: string): void {
    this.#deps.state.update(sessionId, (state) => {
      const index = state.runs.findIndex((entry) => entry.id === runId);
      if (index < 0) return;
      state.runs[index] = markSettling(state.runs[index] as RunRecord);
    });
    this.#deps.onChange?.();
  }

  #windows(config: AutonomyConfig): SleepWindow[] {
    const raw = config.sleepWindows.join(',');
    if (this.#windowsCache !== undefined && this.#windowsCache.raw === raw) return this.#windowsCache.windows;
    const windows = parseSleepWindows(raw);
    this.#windowsCache = { raw, windows };
    return windows;
  }

  #inSleepWindow(now: number, config: AutonomyConfig): boolean {
    const windows = this.#windows(config);
    if (windows.length === 0) return false;
    return isSleepingAt(new Date(now), windows, this.#timeZone(config));
  }

  #wait(config: AutonomyConfig): number {
    return nextWaitMs(config.intervalMinutes, config.jitterRatio, Math.random);
  }

  /** Align one session's next roll with the current config. */
  ensureScheduled(sessionId: string, now = this.#now()): void {
    const state = this.#deps.state.session(sessionId, now + this.#wait(this.#deps.config()));
    if (state === undefined) return;
    if (state.nextCheckAt <= 0) state.nextCheckAt = now + this.#wait(this.#deps.config());
  }

  /** Reset the rhythm for every managed session (config change / manual stop). */
  rescheduleAll(now = this.#now()): void {
    for (const sessionId of this.managedSessions()) {
      this.#deps.state.update(sessionId, (state) => {
        state.nextCheckAt = now + this.#wait(this.#deps.config());
      }, now);
    }
  }

  /** Record that a session saw real activity, so the next roll knows it was recent. */
  noteActivity(sessionId: string, at = this.#now()): void {
    this.#deps.state.update(sessionId, (state) => {
      state.lastActivityAt = Math.max(state.lastActivityAt, at);
    }, at);
  }

  /** One sweep. Re-entrancy is guarded because a turn can outlive the interval. */
  async tick(): Promise<void> {
    if (this.#ticking || this.#stopped) return;
    this.#ticking = true;
    try {
      const config = this.#deps.config();
      if (!config.enabled) return;
      if (this.#deps.review !== undefined) {
        try {
          await this.#deps.review();
        } catch (error) {
          this.#deps.logger.warn(`dsh-autonomy: review failed (${String(error)})`);
        }
      }
      if (this.#deps.drainOutbox !== undefined) {
        try {
          await this.#deps.drainOutbox();
        } catch (error) {
          this.#deps.logger.warn(`dsh-autonomy: outbox sweep failed (${String(error)})`);
        }
      }
      const now = this.#now();
      for (const sessionId of this.managedSessions()) {
        if (this.#stopped) return;
        await this.#consider(sessionId, now, config);
      }
    } catch (error) {
      this.#deps.logger.warn(`dsh-autonomy: scheduler sweep failed (${String(error)})`);
    } finally {
      this.#ticking = false;
    }
  }

  async #consider(sessionId: string, now: number, config: AutonomyConfig): Promise<void> {
    const state = this.#deps.state.session(sessionId, now + this.#wait(config));
    if (state === undefined) return;

    const dueSelfWake = state.selfWake !== undefined && state.selfWake.at <= now;
    const dueRoll = state.nextCheckAt <= now;
    if (!dueSelfWake && !dueRoll) return;

    const sleeping = this.#inSleepWindow(now, config);
    if (sleeping && !(dueSelfWake && config.selfWakeDuringSleep)) {
      // Quiet hours still advance the clock: a window that ends in six hours
      // must not be re-rolled every 15 seconds.
      this.#deps.state.update(sessionId, (session) => {
        if (session.nextCheckAt <= now) session.nextCheckAt = now + this.#wait(config);
      });
      return;
    }

    if (this.#dailyBudgetSpent(sessionId, now, config) || this.#tooRecentlyActive(sessionId, now, config)) {
      this.#deps.state.update(sessionId, (session) => {
        session.nextCheckAt = now + this.#wait(config);
      });
      return;
    }

    if (dueSelfWake) {
      const pending = state.selfWake;
      const note = pending?.note;
      this.#deps.state.update(sessionId, (session) => {
        if (pending !== undefined) {
          session.lastSelfWake = { ...pending, firedAt: now };
        }
        delete session.selfWake;
        session.nextCheckAt = now + this.#wait(config);
      });
      await this.#run(sessionId, 'self', note);
      return;
    }

    // A plain dice roll: advance the clock whatever the outcome, so a miss is
    // just a miss rather than a retry loop.
    this.#deps.state.update(sessionId, (session) => {
      session.nextCheckAt = now + this.#wait(config);
    });

    const probability = wakeProbability({
      mode: config.mode,
      probability: config.probability,
      lastActivityAt: state.lastActivityAt,
      now,
      adaptive: config.adaptive,
    });
    const hit = Math.random() < probability;
    if (!hit) return;
    await this.#run(sessionId, 'random', `roll hit at p=${probability.toFixed(3)}`);
  }

  #dailyBudgetSpent(sessionId: string, now: number, config: AutonomyConfig): boolean {
    const state = this.#deps.state.session(sessionId, now);
    if (state === undefined) return false;
    if (config.maxRunsPerDay <= 0) return false;
    const today = localDay(now);
    const count = state.counterDay === today ? state.counterRuns : 0;
    return count >= config.maxRunsPerDay;
  }

  #tooRecentlyActive(sessionId: string, now: number, config: AutonomyConfig): boolean {
    if (config.minIdleMinutes <= 0) return false;
    const state = this.#deps.state.session(sessionId, now);
    if (state === undefined) return false;
    const last = state.lastActivityAt > 0 ? state.lastActivityAt : undefined;
    const live = last ?? this.#lastLiveActivity(sessionId);
    if (live === undefined) return false;
    return now - live < config.minIdleMinutes * 60_000;
  }

  #lastLiveActivity(sessionId: string): number | undefined {
    const agent = this.#deps.agents.get(sessionId);
    if (agent === undefined) return undefined;
    return lastActivityEpoch(sessionLogOf((agent as { session?: unknown }).session));
  }

  /**
   * One wake, with any throw turned into a recorded outcome. The driver guards
   * itself too; this is the second fence, because an escaping rejection inside
   * the sweep would exit the host.
   */
  async #driveWake(request: WakeRequest): Promise<WakeOutcome> {
    try {
      return await this.#deps.driver.wake(request);
    } catch (error) {
      return {
        status: 'error',
        sessionId: request.sessionId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Manual trigger from the panel or the tool: always runs, bypassing the dice. */
  async runNow(sessionId: string, note = 'manual trigger'): Promise<WakeOutcome> {
    return this.#run(sessionId, 'manual', note);
  }

  async #run(sessionId: string, trigger: RunTrigger, note?: string): Promise<WakeOutcome> {
    const now = this.#now();
    const config = this.#deps.config();
    const runId = newRunId();
    const run = createRun({ sessionId, trigger, ...(note === undefined ? {} : { note }) }, new Date(now), () => runId);

    let openIntents: Intent[] = [];
    let recentNotes: string[] = [];
    this.#deps.state.update(sessionId, (state) => {
      state.runs = [...state.runs, startRun(run, new Date(now))];
      const today = localDay(now);
      if (state.counterDay !== today) {
        state.counterDay = today;
        state.counterRuns = 0;
      }
      state.counterRuns += 1;
      openIntents = state.intents.filter(isOpen);
      // Novelty is measured against what she already finished or already said,
      // so a re-worded repeat of a settled item does not score as new work.
      recentNotes = [
        ...state.intents.filter((intent) => !isOpen(intent)).slice(-5).map((intent) => intent.text),
        ...state.runs
          .filter((entry) => entry.status === 'completed' && (entry.reason ?? '').trim() !== '')
          .slice(-5)
          .map((entry) => entry.reason as string),
      ];
    }, now);
    this.#deps.onChange?.();

    // The ledger is hers, not the chat's: aggregate every session's open intents
    // (deduped by text fingerprint) so a wake in her own room still sees what a
    // real conversation left open.
    const seenText = new Set<string>();
    const ledger: Intent[] = [];
    for (const sid of [sessionId, ...this.#deps.state.sessionIds()]) {
      const entry = this.#deps.state.session(sid);
      if (entry === undefined) continue;
      for (const intent of entry.intents) {
        if (!isOpen(intent)) continue;
        // 暂停期内的不排到眼前：她已经连着几轮看着它没动手，硬摆出来只是噪音。
        if (isParked(intent, now)) continue;
        const key = fingerprint(intent.text);
        if (seenText.has(key)) continue;
        seenText.add(key);
        ledger.push(intent);
      }
    }
    openIntents = ledger;

    // Scored before the turn so the framing can rank what she left open; the
    // ranking never decides *whether* to wake, only what gets foregrounded.
    const candidates: Candidate[] = openIntents.map((intent) => ({
      id: intent.id,
      text: intent.text,
      kind: intent.kind,
      ...(intent.dueAt === undefined ? {} : { dueAt: intent.dueAt }),
      ...(intent.preferredAt === undefined ? {} : { preferredAt: intent.preferredAt }),
      source: intent.source,
    }));
    const ranked = config.scoreEnabled
      ? selectCandidates(rankCandidates(candidates, { now, recent: recentNotes }), {
          threshold: config.scoreThreshold,
          max: MAX_RANKED,
        })
      : [];
    const surfacedIds = ranked.map((entry) => entry.id);
    const scored = ranked
      .map((entry) => ({
          text: entry.text,
          kind: entry.kind,
          score: entry.score,
          why: explain(entry, now),
        }));

    const outcome = await this.#driveWake({
      sessionId,
      runId,
      trigger,
      ...(note === undefined ? {} : { note }),
      openIntents: openIntents.map((intent) => ({
        text: intent.text,
        kind: intent.kind,
        ...(intent.dueAt === undefined ? {} : { dueAt: intent.dueAt }),
        ...(isOverdue(intent, new Date(now)) ? { overdue: true } : {}),
      })),
      ...(scored.length === 0 ? {} : { candidates: scored }),
      ...(config.motivation.trim() === '' ? {} : { motivation: config.motivation }),
    });

    const finishedAt = this.#now();
    this.#deps.state.update(sessionId, (state) => {
      const index = state.runs.findIndex((entry) => entry.id === runId);
      if (index < 0) return;
      const current = state.runs[index] as RunRecord;
      // The agent can end the turn itself with autonomy_finish; its own account
      // outranks anything inferred from the event log, so keep it.
      if (current.status === 'completed') {
        state.lastActivityAt = finishedAt;
        return;
      }
      if (outcome.status === 'ok' && outcome.observation !== undefined) {
        state.runs[index] = settleRun(
          current,
          outcome.observation.decision,
          outcome.observation.replySummary ?? 'observed from session log',
          new Date(finishedAt),
        );
      } else {
        state.runs[index] = settleRun(
          current,
          'no_action',
          outcome.error ?? `wake ${outcome.status}`,
          new Date(finishedAt),
          outcome.status === 'error' ? 'failed' : 'cancelled',
        );
      }
      state.lastActivityAt = finishedAt;
    });

    // 冷度回写：她这一轮真动了手就把排到眼前的清零，没动就各记半格；
    // 连着四轮开到眼前都没动，就暂停七天，不再占候选名额。
    if (surfacedIds.length > 0) {
      const ledgerOwner = config.wakeSession.trim() === '' ? sessionId : config.wakeSession.trim();
      const decision = this.#deps.state.session(ledgerOwner)?.runs.find((entry) => entry.id === runId)?.decision;
      this.#deps.state.update(ledgerOwner, (state) => {
        for (const id of surfacedIds) {
          const index = state.intents.findIndex((intent) => intent.id === id);
          if (index < 0) continue;
          const intent = state.intents[index] as Intent;
          if (intent.state !== 'open') continue;
          state.intents[index] = decision === 'acted' ? recordHit(intent, new Date(finishedAt)) : recordMiss(intent, new Date(finishedAt));
        }
      });
    }
    this.#deps.onChange?.();
    return outcome;
  }
}
