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

import { markOutbox, pendingItems, sweepExpired } from '../core/outbox.js';
import { describeWakeRoom, wakeRoomRequest, WAKE_ROOM_TITLE } from '../core/workspace.js';
import { interjectionDenied, parseSpeakEvents, speakDenied } from '../core/speak.js';
import { loadConfig, saveConfig, type AutonomyConfig } from './settings.js';
import { StateStore } from './state.js';
import { Scheduler } from './scheduler.js';
import { Reviewer } from './reviewer.js';
import { WakeDriver, type SessionControllerLike } from './wake.js';
import { registerAutonomyTools } from './tools.js';
import { PanelService, installPanelRoutes } from './panel.js';
import { MemoryRecall } from './recall.js';
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
  // 排队消息的投递口：调度器每 15 秒扫一遍，服务对象在同一次 apply 里稍后才
  // 构造好，所以这里先留一个可替换的引用。
  let drainOutboxRef: (() => Promise<void>) | undefined;
  let reviewRef: (() => Promise<void>) | undefined;
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
    drainOutbox: async () => {
      await drainOutboxRef?.();
    },
    recall: async (query) => memoryRecall.recall(query),
    review: async () => {
      await reviewRef?.();
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
        | {
            create?: (input: Record<string, unknown>) => Promise<{ sessionId: string }>;
            rename?: (input: { sessionId: string; title: string }) => Promise<unknown>;
          }
        | undefined;
      if (controller === undefined || typeof controller.create !== 'function') {
        throw new Error('宿主的会话控制器不可用，无法新建会话');
      }
      const request = wakeRoomRequest(config.wakeWorkspace);
      const created = await controller.create({ ...request });
      const sessionId = String(created.sessionId);
      // create() 不会给标题：不取名的话面板里就是一条「未命名」。
      if (typeof controller.rename === 'function') {
        try {
          await controller.rename({ sessionId, title: WAKE_ROOM_TITLE });
        } catch (error) {
          logger.warn(`命名房间失败（${sessionId}）：${String(error)}`);
        }
      }
      logger.info(`新建唤醒房间 ${sessionId}，落在 ${describeWakeRoom(request)}`);
      return sessionId;
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
    recentEvents: async (): Promise<unknown> => {
      try {
        const bridge = ctx.get('aurabot') as unknown as {
          events?: (query: { after?: number; limit?: number }) => Promise<unknown>;
        };
        if (typeof bridge.events === 'function') return await bridge.events({ after: 0, limit: 400 });
      } catch {
        // 拿不到就当没有可用的近期事件；守卫退化成只查名单。
      }
      return undefined;
    },
  };

  // 投递排在队里的话：目标一空下来就发，过期就作废。判定与 autonomy_say 用
  // 同一组纯函数，所以排队前后的行为完全一致。
  drainOutboxRef = async (): Promise<void> => {
    const room = config.wakeSession.trim();
    if (room === '') return;
    const queued = state.session(room)?.outbox ?? [];
    if (queued.length === 0) return;
    state.update(room, (session) => {
      session.outbox = sweepExpired(session.outbox ?? [], Date.now());
    }, Date.now());
    for (const item of pendingItems(state.session(room)?.outbox ?? [])) {
      if (speakDenied(item.target, config.speakTargets) !== '') continue;
      const blocked = interjectionDenied(
        item.target,
        parseSpeakEvents(await services.recentEvents()),
        Date.now(),
        config.speakCooldownMinutes * 60_000,
      );
      if (blocked !== '') continue;
      let delivered: { ok?: boolean; message?: string } = { ok: false };
      try {
        delivered = (await services.say(item.target, item.text)) as { ok?: boolean; message?: string };
      } catch (error) {
        delivered = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      const sent = delivered.ok === true;
      state.update(room, (session) => {
        session.outbox = markOutbox(
          session.outbox ?? [],
          item.id,
          sent ? 'sent' : 'failed',
          sent ? (delivered.message ?? 'sent') : (delivered.message ?? 'send failed'),
        );
      }, Date.now());
      logger.info(`[autonomy] outbox ${item.id} → ${item.target === '' ? 'owner private' : item.target}: ${sent ? 'sent' : 'failed'}`);
    }
  };

  // 召回走记忆库自己的只读接口；它跟 aura 无关，aura 那边只剩模型的系统回合。
  const memoryRecall = new MemoryRecall({
    url: () => config.recallUrl,
    limit: () => config.recallLimit,
    timeoutMs: () => config.recallTimeoutMs,
    maxChars: () => config.recallMaxChars,
    log: logger,
  });

  // 复盘的模型通道走 aura 的系统回合（不占任何聊天），记忆走它的 memory 模块；
  // 两样都拿不到就退回确定性模板，复盘照做，只是不蒸馏。
  const reviewer = new Reviewer({
    config: () => config,
    state,
    dataDir,
    now: () => Date.now(),
    log: logger,
    runTurn: async (prompt, options) => {
      const bridge = ctx.get('aurabot') as unknown as
        | { hub?: { runSystemTurn?: (name: string, title: string, prompt: string, opts: Record<string, unknown>) => Promise<unknown> } }
        | undefined;
      const hub = bridge?.hub;
      if (hub === undefined || typeof hub.runSystemTurn !== 'function') throw new Error('aura bot hub 不可用');
      const reply = await hub.runSystemTurn('autonomy-review', '自主 · 复盘', prompt, {
        timeoutMs: options.timeoutMs,
        noTools: true,
        key: 'review',
      });
      return String(reply ?? '');
    },
    // 写记忆默认关着：库那边只开了召回，memory 模块也停着，硬写只会得到
    // 一句「模块没在跑」。真要用时开 reviewWriteMemory，失败照实返回给日志。
    remember: async (text) => {
      if (!config.reviewWriteMemory) return 'reviewWriteMemory 关着，没写';
      const bridge = ctx.get('aurabot') as unknown as
        | { call?: (input: { module: string; method: string; args: unknown[] }) => Promise<unknown> }
        | undefined;
      if (bridge === undefined || typeof bridge.call !== 'function') return 'aura bot 的 call 不可用';
      const result = (await bridge.call({ module: 'memory', method: 'addEvent', args: [{ text, tags: ['自主', '复盘'], importance: 0.5 }] })) as
        | { ok?: boolean; message?: string }
        | undefined;
      if (result?.ok !== true) return result?.message ?? '记忆模块没给回执';
      return undefined;
    },
  });
  reviewRef = async (): Promise<void> => {
    await reviewer.maybeReview();
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
