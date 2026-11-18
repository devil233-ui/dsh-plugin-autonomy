/**
 * dsh-autonomy — an autonomy loop for DSH agent sessions.
 *
 * Semantics carried over from the AstrBot `astrbot_plugin_autonomy` plugin and
 * its upstream `whalelife` original: the *host* decides when to wake a
 * session (a jittered interval, then a probability gate, optionally scaled by
 * how long the session has been quiet), and the model decides what to do with
 * the awakened moment — including doing nothing. The plugin never makes the
 * model set its own timers; a self-scheduled wake exists only as an explicit
 * supplement an agent may request with `autonomy_schedule`.
 *
 * Wire-up:
 *   - config from `<DSH_HOME>/autonomy/config.json`
 *   - per-session state in `<DSH_HOME>/autonomy/state.json`
 *   - Scheduler sweeps due sessions every 15s
 *   - WakeDriver reuses the live agent or resumes a cold session, delivers a
 *     notice-sourced framing message, and observes the settled turn
 *   - autonomy_* tools are registered on every root agent
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';

import { loadConfig, saveConfig, type AutonomyConfig } from './settings.js';
import { StateStore } from './state.js';
import { Scheduler } from './scheduler.js';
import { WakeDriver } from './wake.js';
import { registerAutonomyTools } from './tools.js';
import { PanelService, installPanelRoutes } from './panel.js';
import { asLiveAgent, type AgentsFacade } from './types.js';
import { installIncomingGuard } from './guard.js';
import { createQuietMessage } from './quiet-message.js';
import { appendSuppressed } from './suppressed-log.js';
import { isSleepingAt, parseSleepWindows } from '../core/schedule.js';
import { PLUGIN_NAME } from './framing.js';

export const name = PLUGIN_NAME;
export const inject = ['agents', 'tools'];

function resolveDataDir(): string {
  const home = process.env['DSH_HOME'];
  const base = home !== undefined && home !== '' ? home : join(homedir(), '.dsh');
  return join(base, 'autonomy');
}

function resolveTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function apply(ctx: Context): void {
  const dataDir = resolveDataDir();
  const timeZone = resolveTimeZone();
  const logger = {
    warn: (message: string) => ctx.logger.warn(message),
    error: (message: string) => ctx.logger.error(message),
    info: (message: string) => ctx.logger.info(message),
  };

  let config: AutonomyConfig = loadConfig(dataDir, logger);

  const state = new StateStore(dataDir, config.maxRuns, config.maxIntents);
  let schedulerRef: Scheduler | undefined;
  const driver = new WakeDriver({
    agents: ctx.agents as unknown as AgentsFacade,
    timeZone,
    logger,
    onPhase: (sessionId, runId, phase) => {
      if (phase === 'settling') schedulerRef?.markSettling(sessionId, runId);
    },
  });
  let panel: PanelService | undefined;
  const scheduler = new Scheduler({
    config: () => config,
    state,
    driver,
    agents: ctx.agents as unknown as AgentsFacade,
    timeZone,
    logger,
    onChange: () => {
      panel?.notify();
    },
  });

  const applyConfig = (next: AutonomyConfig): void => {
    config = next;
    state.setLimits(next.maxRuns, next.maxIntents);
    saveConfig(dataDir, next);
    if (next.enabled) scheduler.start();
    else scheduler.stop();
    scheduler.rescheduleAll();
    panel?.notify();
  };

  schedulerRef = scheduler;

  panel = new PanelService({
    dataDir,
    timeZone: () => (config.timezone !== '' ? config.timezone : timeZone),
    getConfig: () => config,
    setConfig: applyConfig,
    state,
    scheduler,
    isLive: (sessionId: string) => {
      try {
        return ctx.agents.get(sessionId as never) !== undefined;
      } catch {
        return false;
      }
    },
    log: (message: string) => logger.info(message),
  });
  const disposePanel = installPanelRoutes(ctx, panel);

  const services = {
    config: () => config,
    state,
    scheduler,
    now: () => Date.now(),
    log: (level: 'info' | 'warn' | 'error', message: string) => logger[level](message),
  };

  // Tools live on the agent scope, so they are re-registered for every root
  // agent the registry publishes — including ones resumed by a cold wake.
  // The quiet-window gate wraps followup/steer on every root agent, so guest
  // turns other plugins push into a session during a sleep window are replaced
  // by a short "stay silent" notice, so the pusher still gets its turn/end.
  const guards: Array<() => void> = [];
  const windowsLabel = (): string =>
    config.sleepWindows.length === 0 ? 'unconfigured' : config.sleepWindows.join(', ');
  const sleepingNow = (): boolean => {
    if (config.sleepWindows.length === 0) return false;
    try {
      const zone = config.timezone !== '' ? config.timezone : timeZone;
      return isSleepingAt(new Date(), parseSleepWindows(config.sleepWindows.join(',')), zone);
    } catch {
      return false;
    }
  };

  const registered = new WeakSet<Agent>();
  const registerOne = (agent: Agent): void => {
    if (registered.has(agent)) return;
    registered.add(agent);
    try {
      registerAutonomyTools(agent.ctx, agent, services);
    } catch (error) {
      logger.warn(`dsh-autonomy: could not register tools on agent ${String(agent.id)} (${String(error)})`);
    }
    const live = asLiveAgent(agent);
    if (live !== undefined) {
      try {
        guards.push(
          installIncomingGuard(live, {
            sleeping: sleepingNow,
            blockGuest: () => config.quietBlockGuest,
            onSuppress: (sessionId, reason, detail) => {
              const at = Date.now();
              state.update(sessionId, (session) => {
                session.suppressedTurns = (session.suppressedTurns ?? 0) + 1;
                session.suppressedAt = at;
              });
              appendSuppressed(dataDir, { at, sessionId, reason, chat: detail.chat, excerpt: detail.excerpt });
              const line = `quiet notice replaced a guest turn in ${sessionId} — ${reason}`;
              logger.warn(`dsh-autonomy: ${line}`);
              console.log(`[dsh-autonomy] ${line}`);
            },
            buildQuiet: (sessionId, detail) =>
              createQuietMessage({
                sessionId,
                chat: detail.chat,
                windows: windowsLabel(),
                excerpt: detail.excerpt,
              }),
            log: (message) => logger.warn(`dsh-autonomy: ${message}`),
          }),
        );
      } catch (error) {
        logger.warn(`dsh-autonomy: could not guard agent ${String(agent.id)} (${String(error)})`);
      }
    }
  };
  ctx.on('agent/created', ({ agent }) => {
    registerOne(agent as Agent);
    return undefined;
  });
  for (const agent of ctx.agents.roots()) registerOne(agent as Agent);

  if (config.enabled) scheduler.start();

  ctx.effect(() => {
    return () => {
      scheduler.stop();
      disposePanel?.();
      for (const dispose of guards) dispose();
    };
  }, 'dsh-autonomy:lifecycle');

  logger.info(
    `dsh-autonomy: started (interval ${config.intervalMinutes}m ±${Math.round(config.jitterRatio * 100)}%, p=${config.probability}, mode=${config.mode}, data ${dataDir})`,
  );
}
