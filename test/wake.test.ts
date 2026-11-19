/**
 * 唤醒路径的护栏测试。
 *
 * 2026-11-19 真实事故：宿主重启后会话控制器还没就绪，`resolveAgent` 回了一个
 * 不认识的对象，旧代码盲目 cast 成 agent，读 `.session.seq` 直接抛错——而这是
 * 在 async wake 里逃出去的 rejection，DSH 的 fail-loud 让它把整个宿主带走。
 * 这两条钉子钉住：认不出就不当 agent；以及 wake 本身绝不向外抛。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WakeDriver, type WakeDeps } from '../src/host/wake.js';
import type { AgentsFacade } from '../src/host/types.js';

function fakeAgent(id: string) {
  return {
    id,
    session: { id, seq: 5 },
    followup() {
      /* delivered */
    },
    runMaintenance<T>(task: () => Promise<T>): Promise<T> {
      return task();
    },
    whenIdle(): Promise<void> {
      return Promise.resolve();
    },
  };
}

function makeDriver(overrides: Partial<WakeDeps> = {}): WakeDriver {
  const agents: AgentsFacade = {
    get: () => undefined,
    resume: async () => ({ agent: fakeAgent('s1') as never, dispose: async () => {} }),
    roots: () => [],
  };
  return new WakeDriver({
    agents,
    timeZone: 'Asia/Shanghai',
    logger: { warn() {} },
    ...overrides,
  });
}

const request = {
  sessionId: 's1',
  runId: 'r1',
  trigger: 'manual' as const,
  openIntents: [],
};

test('wake-guard：控制器回 { error } 时记成失败，不把 error 对象当 agent', async () => {
  const driver = makeDriver({
    sessionController: () => ({ resolveAgent: async () => ({ error: { message: 'boom' } }) }),
  });
  const outcome = await driver.wake(request);
  assert.equal(outcome.status, 'error');
  assert.match(outcome.error ?? '', /boom/);
});

test('wake-guard：控制器回 resume 句柄 { agent } 时能拆出 agent 并跑完一轮', async () => {
  const driver = makeDriver({
    sessionController: () => ({ resolveAgent: async () => ({ agent: fakeAgent('s1'), dispose: async () => {} }) }),
  });
  const outcome = await driver.wake(request);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.sessionId, 's1');
});

test('wake-guard：认不出的对象一律不算 agent，退回 resume 那条路', async () => {
  let resumed = 0;
  const agents: AgentsFacade = {
    get: () => ({ id: 's1' }) as never, // 形状不全：没有 session / followup
    resume: async () => {
      resumed += 1;
      return { agent: fakeAgent('s1') as never, dispose: async () => {} };
    },
    roots: () => [],
  };
  const driver = makeDriver({ agents });
  const outcome = await driver.wake(request);
  assert.equal(resumed, 1);
  assert.equal(outcome.status, 'ok');
});
