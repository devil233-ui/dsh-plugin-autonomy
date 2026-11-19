/**
 * Configuration: defaults, validation, and the config.json overlay.
 *
 * The knobs mirror the AstrBot/whalelife autonomy plugin so an operator can
 * carry settings across: an average check interval, a probability gate, an
 * optional adaptive multiplier keyed on time since last activity, and quiet
 * (sleep) windows. Two knobs are DSH-specific and have no AstrBot peer:
 * `minIdleMinutes` (never wake an agent that is still working) and
 * `sessions` (which agent sessions this host should consider).
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseSleepWindows, type ProbabilityInput } from '../core/schedule.js';

export interface AdaptiveConfig {
  recentMinutes: number;
  recentMultiplier: number;
  distantMinutes: number;
  distantMultiplier: number;
}

export interface AutonomyConfig {
  /** Average minutes between two dice rolls. */
  intervalMinutes: number;
  /** Random jitter half-width as a fraction of the interval (0.1 = ±10%). */
  jitterRatio: number;
  /** Probability that one roll actually wakes the agent. */
  probability: number;
  mode: ProbabilityInput['mode'];
  adaptive: AdaptiveConfig;
  /**
   * Quiet windows, comma separated `HH:mm-HH:mm` or `HH:mm-HH:mm@startDay-endDay`
   * (0=Sunday … 6=Saturday), e.g. `23:00-08:00@5-1` is Fri 23:00 → Mon 08:00.
   */
  sleepWindows: string[];
  /** IANA zone used for every clock decision; empty means the host zone. */
  timezone: string;
  /** Whether the model may schedule its own wake with autonomy_schedule. */
  allowSelfWake: boolean;
  /** Overrides the paragraph the model reads at the start of an autonomous turn. */
  motivation: string;
  /** Whether a self-scheduled wake may fire inside a sleep window. */
  selfWakeDuringSleep: boolean;
  /** Hard ceiling on judgement runs per session per local day. */
  maxRunsPerDay: number;
  /** Skip a roll while the agent's session received activity this recently. */
  minIdleMinutes: number;
  /** Sessions to supervise; empty means every live root agent. */
  sessions: string[];
  /**
   * Where a wake actually lands. Non-empty overrides `sessions`: the scheduler
   * watches this one session only, so her autonomous turns happen in her own
   * room instead of a chat (an aura group session drops the local tools while
   * the last speaker was a guest, which is exactly what a wake must not hit).
   */
  wakeSession: string;
  /**
   * The only chats `autonomy_say` may point at (`group:<id>` / `private:<qq>`).
   *
   * An enforced allowlist, empty by default: while it is empty an autonomous
   * turn cannot send anything. Aura's outbound rules still apply on top, but
   * they are a share gate that also rate-limits by mood and activity, so they
   * cannot stand in for a policy of our own.
   */
  speakTargets: string[];
  /** Rank open intents by a recomputable score before an autonomous turn. */
  scoreEnabled: boolean;
  /** Items scoring below this stay off the prompt; the intents themselves stay open. */
  scoreThreshold: number;
  /** Whether the scheduler runs at all. */
  enabled: boolean;
  /** Lines of judgement history kept per session. */
  maxRuns: number;
  /** Intent rows kept per session. */
  maxIntents: number;
}

export const DEFAULT_CONFIG: AutonomyConfig = {
  intervalMinutes: 30,
  jitterRatio: 0.1,
  probability: 0.2,
  mode: 'fixed',
  adaptive: {
    recentMinutes: 20,
    recentMultiplier: 0.15,
    distantMinutes: 360,
    distantMultiplier: 1.5,
  },
  sleepWindows: [],
  timezone: '',
  allowSelfWake: true,
  motivation: '',
  selfWakeDuringSleep: false,
  maxRunsPerDay: 20,
  minIdleMinutes: 0,
  sessions: [],
  wakeSession: '',
  speakTargets: [],
  scoreEnabled: true,
  scoreThreshold: 0.5,
  enabled: true,
  maxRuns: 20,
  maxIntents: 50,
};

function numberOr(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function zoneOr(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const zone = value.trim();
  if (zone === '') return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return fallback;
  }
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function stringArrayOr(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

/** Validate one partial config (from config.json or the panel) into a full one. */
export function normalizeConfig(raw: unknown, base: AutonomyConfig = DEFAULT_CONFIG): AutonomyConfig {
  const input = (raw ?? {}) as Record<string, unknown>;
  const adaptiveRaw = (input.adaptive ?? {}) as Record<string, unknown>;
  const mode = input.mode === 'adaptive' ? 'adaptive' : 'fixed';
  const sleepWindows = stringArrayOr(input.sleepWindows, base.sleepWindows);

  // Reject a malformed window list outright instead of silently ignoring it:
  // a quiet-hours typo that turns into "always awake" is the failure mode an
  // operator notices last.
  parseSleepWindows(sleepWindows.join(','));

  return {
    intervalMinutes: numberOr(input.intervalMinutes, base.intervalMinutes, 1, 24 * 60),
    jitterRatio: numberOr(input.jitterRatio, base.jitterRatio, 0, 0.9),
    probability: numberOr(input.probability, base.probability, 0, 1),
    mode,
    adaptive: {
      recentMinutes: numberOr(adaptiveRaw.recentMinutes, base.adaptive.recentMinutes, 1, 24 * 60),
      recentMultiplier: numberOr(adaptiveRaw.recentMultiplier, base.adaptive.recentMultiplier, 0, 1),
      distantMinutes: numberOr(adaptiveRaw.distantMinutes, base.adaptive.distantMinutes, 1, 7 * 24 * 60),
      distantMultiplier: numberOr(adaptiveRaw.distantMultiplier, base.adaptive.distantMultiplier, 1, 10),
    },
    sleepWindows,
    timezone: zoneOr(input.timezone, base.timezone),
    allowSelfWake: booleanOr(input.allowSelfWake, base.allowSelfWake),
    motivation: textOr(input.motivation, base.motivation),
    selfWakeDuringSleep: booleanOr(input.selfWakeDuringSleep, base.selfWakeDuringSleep),
    maxRunsPerDay: Math.round(numberOr(input.maxRunsPerDay, base.maxRunsPerDay, 0, 500)),
    minIdleMinutes: numberOr(input.minIdleMinutes, base.minIdleMinutes, 0, 24 * 60),
    sessions: stringArrayOr(input.sessions, base.sessions),
    wakeSession: textOr(input.wakeSession, base.wakeSession),
    speakTargets: stringArrayOr(input.speakTargets, base.speakTargets),
    scoreEnabled: booleanOr(input.scoreEnabled, base.scoreEnabled),
    scoreThreshold: numberOr(input.scoreThreshold, base.scoreThreshold, 0, 1),
    enabled: booleanOr(input.enabled, base.enabled),
    maxRuns: Math.round(numberOr(input.maxRuns, base.maxRuns, 1, 200)),
    maxIntents: Math.round(numberOr(input.maxIntents, base.maxIntents, 1, 500)),
  };
}

/** Read `<dataDir>/config.json` if present; absent or unreadable means defaults. */
export function loadConfig(dataDir: string, logger?: { warn(message: string): void }): AutonomyConfig {
  const file = join(dataDir, 'config.json');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return DEFAULT_CONFIG;
  }
  try {
    return normalizeConfig(JSON.parse(text));
  } catch (error) {
    logger?.warn(`dsh-autonomy: config.json is not valid JSON, falling back to defaults (${String(error)})`);
    return DEFAULT_CONFIG;
  }
}

/** Persist the whole config atomically (tmp + rename, like the state file). */
export function saveConfig(dataDir: string, config: AutonomyConfig): void {
  const file = join(dataDir, 'config.json');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}
