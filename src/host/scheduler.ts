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
import { isOpen } from '../core/intent.js';
import {
  isSleepingAt,
  minutesOfDay,
  nextWaitMs,
  parseSleepWindows,
  wakeProbability,
  type SleepWindow,
} from '../core/schedule.js';
import type { RunRecord, RunTrigger } from '../core/run.js';
import { createRun, settleRun, startRun } from '../core/run.js';
import { localDay, type StateStore } from './state.js';
import { lastActivityEpoch } from './observer.js';
import { sessionLogOf, type AgentsFacade } from './types.js';
import type { AutonomyConfig } from './settings.js';
import type { WakeDriver, WakeOutcome } from './wake.js';

export interface SchedulerDeps {
  config(): AutonomyConfig;
  state: StateStore;
  driver: WakeDriver;
  agents: AgentsFacade;
  timeZone: string;
  logger: { warn(message: string): void; info?(message: string): void };
  /** Notified after every judgement so the panel can refresh. */
  onChange?: () => void;
}

const SWEEP_MS = 15_000;

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

  /** Sessions this host supervises: the configured list, or every live root agent. */
  managedSessions(): string[] {
    const config = this.#deps.config();
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
    return isSleepingAt(new Date(now), windows, this.#deps.timeZone);
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
      const note = state.selfWake?.note;
      this.#deps.state.update(sessionId, (session) => {
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

  /** Manual trigger from the panel or the tool: always runs, bypassing the dice. */
  async runNow(sessionId: string, note = 'manual trigger'): Promise<WakeOutcome> {
    return this.#run(sessionId, 'manual', note);
  }

  async #run(sessionId: string, trigger: RunTrigger, note?: string): Promise<WakeOutcome> {
    const now = this.#now();
    const runId = newRunId();
    const run = createRun({ sessionId, trigger, ...(note === undefined ? {} : { note }) }, new Date(now), () => runId);

    let openIntents: Intent[] = [];
    this.#deps.state.update(sessionId, (state) => {
      state.runs = [...state.runs, startRun(run, new Date(now))];
      const today = localDay(now);
      if (state.counterDay !== today) {
        state.counterDay = today;
        state.counterRuns = 0;
      }
      state.counterRuns += 1;
      openIntents = state.intents.filter(isOpen);
    }, now);
    this.#deps.onChange?.();

    const outcome = await this.#deps.driver.wake({
      sessionId,
      runId,
      trigger,
      ...(note === undefined ? {} : { note }),
      openIntents: openIntents.map((intent) => ({
        text: intent.text,
        kind: intent.kind,
        ...(intent.dueAt === undefined ? {} : { dueAt: intent.dueAt }),
      })),
    });

    const finishedAt = now + 1;
    this.#deps.state.update(sessionId, (state) => {
      const index = state.runs.findIndex((entry) => entry.id === runId);
      if (index < 0) return;
      const current = state.runs[index] as RunRecord;
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
    this.#deps.onChange?.();
    return outcome;
  }
}
