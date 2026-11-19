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
import { WakeDriver, type SessionControllerLike } from './wake.js';
import { registerAutonomyTools } from './tools.js';
import { PanelService, installPanelRoutes } from './panel.js';
import type { AgentsFacade } from './types.js';
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
    speakTargets: () => config.speakTargets,
    logger,
    // 冷会话按控制器恢复，才带得上预设与模型；取不到就退回裸 resume。
    sessionController: () => {
      try {
        return ctx.get('sessionController') as unknown as SessionControllerLike | undefined;
      } catch {
        return undefined;
      }
    },
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
    createWakeSession: async () => {
      const controller = ctx.get('sessionController') as unknown as
        | { create?: (input: Record<string, unknown>) => Promise<{ sessionId: string }> }
        | undefined;
      if (controller === undefined || typeof controller.create !== 'function') {
        throw new Error('宿主的会话控制器不可用，无法新建会话');
      }
      const created = await controller.create({});
      return String(created.sessionId);
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
    // 说话走 aura 的服务（同进程直接调用），不经它的 tools.restrict：
    // 群会话里的工具闸只在「这一轮不是主人」时收起工具，管不到这条服务路径；
    // 目标白名单、试运行、总开关仍然是 aura 自己的 canSend 说了算。
    say: async (target: string, text: string): Promise<unknown> => {
      let bridge: { send?: (input: { target?: string; text: string }) => Promise<unknown> } | undefined;
      try {
        bridge = ctx.get('aurabot') as unknown as typeof bridge;
      } catch {
        bridge = undefined;
      }
      if (bridge === undefined || typeof bridge.send !== 'function') {
        return { ok: false, message: 'aurabot 服务不可用（没装 aura 插件）' };
      }
      return target === '' ? await bridge.send({ text }) : await bridge.send({ target, text });
    },
  };

  // Tools live on the agent scope, so they are re-registered for every root
  // agent the registry publishes — including ones resumed by a cold wake.
  const registered = new WeakSet<Agent>();
  const registerOne = (agent: Agent): void => {
    if (registered.has(agent)) return;
    registered.add(agent);
    try {
      registerAutonomyTools(agent.ctx, agent, services);
    } catch (error) {
      logger.warn(`dsh-autonomy: could not register tools on agent ${String(agent.id)} (${String(error)})`);
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
    };
  }, 'dsh-autonomy:lifecycle');

  logger.info(
    `dsh-autonomy: started (interval ${config.intervalMinutes}m ±${Math.round(config.jitterRatio * 100)}%, p=${config.probability}, mode=${config.mode}, data ${dataDir})`,
  );
}
