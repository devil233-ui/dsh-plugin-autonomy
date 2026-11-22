/**
 * 建房间时那个「工作区」栏要判形状：id 走 workspaceId，路径走 cwd。
 *
 * 不传这两样就落到宿主的默认 cwd（通常是 `/root`），房间会掉进 root 工作区，
 * 跟她的聊天会话分家，列表里还会显示成未命名。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeWakeRoom, wakeRoomRequest, WAKE_ROOM_TITLE } from '../src/core/workspace.js';

test('workspace: 空值走宿主默认', () => {
  assert.deepEqual(wakeRoomRequest(''), {});
  assert.deepEqual(wakeRoomRequest('   '), {});
  assert.equal(describeWakeRoom({}), 'the host default workspace');
});

test('workspace: uuid 当工作区 id 传', () => {
  const id = '0a376a7f-8788-4b65-8e67-fdcd1c9a701f';
  assert.deepEqual(wakeRoomRequest(id), { workspaceId: id });
  assert.equal(describeWakeRoom(wakeRoomRequest(id)), 'workspace 0a376a7f');
});

test('workspace: 绝对路径当 cwd 传', () => {
  assert.deepEqual(wakeRoomRequest('/srv/agent-workspace'), { cwd: '/srv/agent-workspace' });
});

test('workspace: 房间标题固定，不留未命名', () => {
  assert.equal(WAKE_ROOM_TITLE, '自主意识 · 她的房间');
});
