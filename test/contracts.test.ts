/**
 * 契约测试：把 whalelife 用 tests/ 钉死的几条语义搬过来。
 *
 * 这些测试跑的是 Scheduler 的行为，而不是纯函数，所以用内存假实现代替
 * StateStore / WakeDriver / AgentRegistry —— 调度器本来就只通过这几个接口
 * 与宿主交互，注入假件就能在没有宿主的情况下复现窗口、队列与恢复路径。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RunRecord } from '../src/core/run.js';
import { isSpeakTarget } from '../src/core/speak.js';
import { renderFramingText } from '../src/host/framing.js';
import { PanelService } from '../src/host/panel.js';
import { Scheduler } from '../src/host/scheduler.js';
import { normalizeConfig, type AutonomyConfig } from '../src/host/settings.js';
import type { SessionState, StateStore } from '../src/host/state.js';
import type { WakeOutcome, WakeRequest } from '../src/host/wake.js';
import type { AgentsFacade } from '../src/host/types.js';

/** StateStore 的最小可用替身：内存里放同一份字典。 */
class MemoryState {
  readonly sessions: Record<string, SessionState> = {};

  session(sessionId: string, createWith?: number): SessionState | undefined {
    const existing = this.sessions[sessionId];
    if (existing !== undefined) return existing;
    if (createWith === undefined) return undefined;
    const created: SessionState = {
      sessionId,
      lastActivityAt: 0,
      nextCheckAt: createWith,
      intents: [],
      runs: [],
      counterRuns: 0,
    };
    this.sessions[sessionId] = created;
    return created;
  }

  update(sessionId: string, mutate: (state: SessionState) => void, createWith?: number): SessionState | undefined {
    const session = this.session(sessionId, createWith);
    if (session === undefined) return undefined;
    mutate(session);
    return session;
  }

  sessionIds(): string[] {
    return Object.keys(this.sessions);
  }
}

class FakeDriver {
  readonly calls: WakeRequest[] = [];
  status: 'ok' | 'busy' = 'ok';

  async wake(request: WakeRequest): Promise<WakeOutcome> {
    this.calls.push(request);
    if (this.status === 'busy') return { status: 'busy', sessionId: request.sessionId };
    return {
      status: 'ok',
      sessionId: request.sessionId,
      observation: { decision: 'no_action', replySummary: 'contract test', toolCalls: 0, spoke: false },
    };
  }
}

function makeScheduler(config: Partial<AutonomyConfig> = {}, sessions: string[] = ['s1']) {
  const state = new MemoryState();
  const driver = new FakeDriver();
  const agents = { roots: () => [], get: () => undefined } as unknown as AgentsFacade;
  const full = normalizeConfig({ sessions, ...config });
  const scheduler = new Scheduler({
    config: () => full,
    state: state as unknown as StateStore,
    driver: driver as unknown as never,
    agents,
    timeZone: 'Asia/Shanghai',
    logger: { warn: () => undefined },
  });
  return { scheduler, state, driver, config: full };
}

test('quiet-contract：睡眠时段内不消费自排唤醒，也不掷骰', async () => {
  const { scheduler, state, driver } = makeScheduler({ sleepWindows: ['00:00-23:59'], probability: 1 });
  const session = state.session('s1', Date.now()) as SessionState;
  session.nextCheckAt = 0;
  session.selfWake = { at: 0, note: 'should stay pending' };

  await scheduler.tick();

  assert.equal(driver.calls.length, 0, '睡眠时段内不该有任何唤醒');
  assert.notEqual(session.selfWake, undefined, '自排安排必须保留，等窗口过去');
  assert.ok(session.nextCheckAt > 0, '时钟仍要推进，否则每 15 秒重掷一次');
});

test('queue-contract：自排优先级高于随机，且会被原子消耗', async () => {
  const { scheduler, state, driver } = makeScheduler({ probability: 0 });
  const session = state.session('s1', Date.now()) as SessionState;
  session.nextCheckAt = 0;
  session.selfWake = { at: 0, note: 'self note' };

  await scheduler.tick();

  assert.equal(driver.calls.length, 1, '自排到点必须唤醒一次，哪怕概率为 0');
  assert.equal(driver.calls[0]?.trigger, 'self');
  assert.equal(driver.calls[0]?.note, 'self note');
  assert.equal(session.selfWake, undefined, '开始判断时原子消耗');
  assert.equal(session.lastSelfWake?.note, 'self note', '面板要能看到她排过');
});

test('queue-contract：概率未命中时不唤醒，但时钟照常推进', async () => {
  const { scheduler, state, driver } = makeScheduler({ probability: 0 });
  const session = state.session('s1', Date.now()) as SessionState;
  session.nextCheckAt = 0;

  await scheduler.tick();

  assert.equal(driver.calls.length, 0);
  assert.ok(session.nextCheckAt > 0);
});

test('daily-budget：超出每日上限后不再唤醒', async () => {
  const { scheduler, state, driver } = makeScheduler({ probability: 1, maxRunsPerDay: 1 });
  const session = state.session('s1', Date.now()) as SessionState;
  session.nextCheckAt = 0;
  session.counterDay = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  session.counterRuns = 1;

  await scheduler.tick();

  assert.equal(driver.calls.length, 0, '当天额度已用完');
});

test('recovery-contract：重启时仍在跑的判断判为中断，不重放', () => {
  const { scheduler, state } = makeScheduler();
  const session = state.session('s1', Date.now()) as SessionState;
  session.runs = [
    { id: 'r1', sessionId: 's1', trigger: 'random', status: 'running', startedAt: new Date().toISOString() },
    { id: 'r2', sessionId: 's1', trigger: 'random', status: 'settling', startedAt: new Date().toISOString() },
    { id: 'r3', sessionId: 's1', trigger: 'random', status: 'completed', decision: 'no_action', startedAt: new Date().toISOString() },
  ];

  const touched = scheduler.recoverInterrupted();

  assert.equal(touched, 2);
  assert.equal(session.runs[0]?.status, 'interrupted');
  assert.equal(session.runs[1]?.status, 'interrupted');
  assert.equal(session.runs[2]?.status, 'completed', '已结算的不动');
  assert.match(String(session.runs[0]?.reason), /restarted/);
});

test('settling：领取成功后、结论未定时标记为 settling', async () => {
  const { scheduler, state } = makeScheduler();
  const session = state.session('s1', Date.now()) as SessionState;
  session.runs = [
    { id: 'r9', sessionId: 's1', trigger: 'manual', status: 'running', startedAt: new Date().toISOString() },
  ];

  scheduler.markSettling('s1', 'r9');

  assert.equal(session.runs[0]?.status, 'settling');
});

test('cancel-contract：没有自排时取消是空操作，不会凭空造出安排', async () => {
  const { scheduler, state } = makeScheduler();
  const session = state.session('s1', Date.now()) as SessionState;
  session.selfWakeVersion = 3;

  assert.equal(session.selfWake, undefined);
  await scheduler.tick();
  assert.equal(session.selfWakeVersion, 3);
});

test('wake-room：配置了唤醒落点就只盯这一个会话', () => {
  const { scheduler } = makeScheduler({ wakeSession: 'session-room' }, ['s1', 's2']);
  assert.deepEqual(scheduler.managedSessions(), ['session-room']);
});

test('wake-room：落点为空时仍按目标会话列表', () => {
  const { scheduler } = makeScheduler({}, ['s1', 's2']);
  assert.deepEqual(scheduler.managedSessions(), ['s1', 's2']);
});

test('speak-contract：去处由她自己挑，名单只当提示，地址形态仍要合法', () => {
  const base = {
    runId: 'r1',
    sessionId: 's1',
    trigger: 'random' as const,
    now: new Date('2026-11-19T12:00:00Z'),
    openIntents: [],
    timeZone: 'Asia/Shanghai',
  };
  const bare = renderFramingText({ ...base, speakTargets: [] });
  assert.match(bare, /autonomy_say/);
  assert.match(bare, /aura bot's own outbound rules/);

  const aloud = renderFramingText({ ...base, speakTargets: ['group:1053858006'] });
  assert.match(aloud, /Chats you have used before: group:1053858006/);

  assert.equal(isSpeakTarget('group:1053858006'), true);
  assert.equal(isSpeakTarget('private:1250226509'), true);
  assert.equal(isSpeakTarget(''), true, '空目标 = 找主人私聊');
  assert.equal(isSpeakTarget('group:abc'), false);
  assert.equal(isSpeakTarget('1053858006'), false);
});

test('score-contract：打分结果进 framing，并声明它只是排序不是命令', () => {
  const text = renderFramingText({
    runId: 'r1',
    sessionId: 's1',
    trigger: 'random',
    now: new Date('2026-11-19T12:00:00Z'),
    timeZone: 'Asia/Shanghai',
    openIntents: [
      { text: '把二创补发到剧透群', kind: 'agreement', dueAt: '2026-11-19T09:00:00.000Z', overdue: true },
      { text: '研究一下票圈排版', kind: 'thought' },
    ],
    candidates: [
      { text: '把二创补发到剧透群', kind: 'agreement', score: 0.87, why: 'overdue by 3h; new; a promise to someone' },
    ],
  });
  assert.match(text, /0\.87 \[agreement\] 把二创补发到剧透群/);
  assert.match(text, /an ordering, not an order/);
  assert.match(text, /still open; it just scored lower/);
});

test('today-view：合并视图跨会话收集今天的判断，隔天的旧记录不进', () => {
  const nowMs = Date.now();
  const run = (sessionId: string, id: string, startedAt: string): RunRecord => ({
    id,
    sessionId,
    trigger: 'random',
    status: 'completed',
    decision: 'no_action',
    reason: 'r',
    startedAt,
  });
  const state = new MemoryState();
  state.sessions['s1'] = {
    sessionId: 's1',
    lastActivityAt: nowMs,
    nextCheckAt: 0,
    intents: [],
    runs: [run('s1', 'old', new Date(nowMs - 3 * 86_400_000).toISOString()), run('s1', 'b', new Date(nowMs).toISOString())],
    counterRuns: 2,
  };
  state.sessions['s2'] = {
    sessionId: 's2',
    lastActivityAt: nowMs,
    nextCheckAt: 0,
    intents: [],
    runs: [run('s2', 'c', new Date(nowMs - 60_000).toISOString())],
    counterRuns: 1,
  };
  const panel = new PanelService({
    dataDir: '/tmp',
    timeZone: 'Asia/Shanghai',
    getConfig: () => normalizeConfig({}),
    setConfig: () => undefined,
    state: state as unknown as StateStore,
    scheduler: { managedSessions: () => ['s1', 's2'] } as unknown as Scheduler,
    isLive: () => false,
    log: () => undefined,
  });
  const snapshot = panel.snapshot();
  assert.deepEqual(snapshot.todayRuns.map((entry) => entry.id), ['b', 'c']);
});

test('runs-query：跨会话分页、筛选与计数', () => {
  const nowMs = Date.now();
  const count = (state: MemoryState, key: string, runs: RunRecord[], intents: SessionState['intents'] = []): void => {
    state.sessions[key] = { sessionId: key, lastActivityAt: nowMs, nextCheckAt: 0, intents, runs, counterRuns: runs.length };
  };
  const state = new MemoryState();
  count(state, 's1', [
    { id: 'a', sessionId: 's1', trigger: 'random', status: 'completed', decision: 'acted', reason: '补发剧透群', startedAt: new Date(nowMs).toISOString() },
    { id: 'b', sessionId: 's1', trigger: 'manual', status: 'completed', decision: 'no_action', reason: '没有待办', startedAt: new Date(nowMs - 3_600_000).toISOString() },
  ]);
  count(state, 's2', [
    { id: 'c', sessionId: 's2', trigger: 'self', status: 'busy', reason: '会话正忙', startedAt: new Date(nowMs - 1_800_000).toISOString() },
  ]);
  const panel = new PanelService({
    dataDir: '/tmp',
    timeZone: 'Asia/Shanghai',
    getConfig: () => normalizeConfig({}),
    setConfig: () => undefined,
    state: state as unknown as StateStore,
    scheduler: { managedSessions: () => ['s1', 's2'] } as unknown as Scheduler,
    isLive: () => false,
    log: () => undefined,
  });

  const all = panel.runs({});
  assert.equal(all.total, 3);
  assert.deepEqual(all.rows.map((row) => row.id), ['a', 'c', 'b']);
  assert.equal(all.triggers['random'], 1);
  assert.equal(all.outcomes['acted'], 1);
  assert.equal(all.outcomes['busy'], 1);

  const paged = panel.runs({ limit: 2, offset: 2 });
  assert.equal(paged.total, 3);
  assert.deepEqual(paged.rows.map((row) => row.id), ['b']);

  assert.equal(panel.runs({ trigger: 'manual' }).total, 1);
  assert.deepEqual(panel.runs({ outcome: 'no_action' }).rows.map((row) => row.id), ['b']);
  assert.deepEqual(panel.runs({ session: 's2' }).rows.map((row) => row.id), ['c']);
  assert.deepEqual(panel.runs({ q: '剧透' }).rows.map((row) => row.id), ['a']);
  // 计数反映的是筛选前的全集，页面上的筛选片才有数字可显示。
  assert.equal(panel.runs({ trigger: 'manual' }).outcomes['acted'], 1);
});

test('ledger-settle：唤醒房间显示别人的账本行，点完成要落回原会话', async () => {
  const nowMs = Date.now();
  const state = new MemoryState();
  const intent = {
    id: 'i534c159d',
    text: '补发剧透群',
    kind: 'thought' as const,
    state: 'open' as const,
    version: 1,
    source: 'self' as const,
    createdAt: new Date(nowMs - 60_000).toISOString(),
    updatedAt: new Date(nowMs - 60_000).toISOString(),
  };
  state.sessions['chat'] = {
    sessionId: 'chat',
    lastActivityAt: nowMs,
    nextCheckAt: 0,
    intents: [intent],
    runs: [],
    counterRuns: 0,
  };
  state.sessions['room'] = {
    sessionId: 'room',
    lastActivityAt: nowMs,
    nextCheckAt: 0,
    intents: [],
    runs: [],
    counterRuns: 0,
  };
  const panel = new PanelService({
    dataDir: '/tmp',
    timeZone: 'Asia/Shanghai',
    getConfig: () => normalizeConfig({ wakeSession: 'room' }),
    setConfig: () => undefined,
    state: state as unknown as StateStore,
    scheduler: { managedSessions: () => ['room'], rescheduleAll: () => undefined } as unknown as Scheduler,
    isLive: () => false,
    log: () => undefined,
  });

  // 唤醒房间看到的是跨会话汇总，行上要带原持有者。
  const room = panel.snapshot().sessions.find((row) => row.sessionId === 'room');
  assert.deepEqual(room?.openIntents.map((row) => [row.id, row.ownerSessionId]), [['i534c159d', 'chat']]);

  // 请求打到房间上（页面上选中的就是它），仍要落到真正持有这条的会话。
  const result = await panel.action({ type: 'intent-settle', sessionId: 'room', id: 'i534c159d', state: 'done', version: 1 });
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error));
  assert.equal(state.sessions['chat']?.intents[0]?.state, 'done');
  assert.equal(state.sessions['room']?.intents.length, 0);
});
