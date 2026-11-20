/**
 * 台账的「读」必须与唤醒提示一致。
 *
 * 唤醒提示把全库未收尾的意图都摆给她看；那么 autonomy_intents list 也必须
 * 看得见同样这几条，否则她会一边被提示「你有三条待办」、一边在工具里只看到
 * 一条，把另外两条当成历史。这里用内存假 StateStore 钉住这条一致性。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Intent } from '../src/core/intent.js';
import type { SessionState, StateStore } from '../src/host/state.js';
import { normalizeConfig } from '../src/host/settings.js';
import { autonomyToolDefinitions, type ToolServices } from '../src/host/tools.js';
import type { Agent } from '@deepseek-ai/dsh-agent';

const ROOM = 'session-aaaa1111';
const CHAT = 'session-bbbb2222';
const OTHER = 'session-cccc3333';

function intent(id: string, text: string): Intent {
  return {
    id,
    text,
    kind: 'thought',
    source: 'self',
    state: 'open',
    createdAt: '2026-11-20T01:00:00.000Z',
    updatedAt: '2026-11-20T01:00:00.000Z',
    version: 1,
  };
}

function fakeState(byId: Record<string, Intent[]>): StateStore {
  const sessions: Record<string, SessionState> = {};
  for (const [sessionId, intents] of Object.entries(byId)) {
    sessions[sessionId] = {
      sessionId,
      lastActivityAt: 0,
      nextCheckAt: 0,
      intents,
      runs: [],
      counterRuns: 0,
    };
  }
  return {
    sessionIds: () => Object.keys(sessions),
    session: (sessionId: string) => sessions[sessionId],
  } as unknown as StateStore;
}

function services(state: StateStore, wakeSession: string): ToolServices {
  return {
    config: () => normalizeConfig({ wakeSession, enabled: true }),
    state,
    scheduler: {} as ToolServices['scheduler'],
    now: () => Date.parse('2026-11-20T02:00:00.000Z'),
    log: () => {},
  };
}

async function listFrom(agentId: string, toolServices: ToolServices): Promise<Record<string, unknown>> {
  const tools = autonomyToolDefinitions({ id: agentId } as unknown as Agent, toolServices);
  const tool = tools.find((entry) => entry.name === 'autonomy_intents');
  assert.ok(tool !== undefined, 'autonomy_intents is registered');
  const result = await tool.execute({ action: 'list' }, {} as never);
  return result as Record<string, unknown>;
}

test('ledger-list: every session is visible, same as the wake prompt', async () => {
  const state = fakeState({
    [ROOM]: [intent('i1', 'room entry')],
    [CHAT]: [intent('i2', 'chat entry')],
    [OTHER]: [intent('i3', 'third entry')],
  });
  const result = await listFrom(ROOM, services(state, ROOM));
  assert.equal(result['count'], 3);
  const rows = result['intents'] as Array<{ id: string; ledger: string }>;
  const labels = Object.fromEntries(rows.map((row) => [row.id, row.ledger]));
  assert.equal(labels['i1'], 'this session');
  assert.equal(labels['i2'], 'other session bbbb2222');
  assert.equal(labels['i3'], 'other session cccc3333');
});

test('ledger-list: the wake room is named as such when read from a chat', async () => {
  const state = fakeState({
    [ROOM]: [intent('i1', 'room entry')],
    [CHAT]: [intent('i2', 'chat entry')],
  });
  const result = await listFrom(CHAT, services(state, ROOM));
  assert.equal(result['count'], 2);
  const rows = result['intents'] as Array<{ id: string; ledger: string }>;
  const labels = Object.fromEntries(rows.map((row) => [row.id, row.ledger]));
  assert.equal(labels['i1'], 'wake room');
  assert.equal(labels['i2'], 'this session');
});
