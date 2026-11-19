/**
 * 说话闸（`src/core/speak.ts`）的钉子。
 *
 * 两层：名单（谁许她说）+ 插队守卫（那会儿合不合适说）。名单是配置，
 * 守卫完全从 aura 的事件环里重算，所以这里逐条钉住判定边界。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { interjectionDenied, parseSpeakEvents, speakDenied } from '../src/core/speak.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const group = 'group:1053858006';

test('speak: 主人私聊不用配置也放行', () => {
  assert.equal(speakDenied('', []), '');
  assert.equal(speakDenied('', [group]), '');
});

test('speak: 名单为空时群聊一律不发', () => {
  assert.match(speakDenied(group, []), /whitelisted chats: none/);
});

test('speak: 不在名单里的地址被拒，并说明主人私聊仍可用', () => {
  assert.match(speakDenied('group:100200300', [group]), /not allowed/);
  assert.match(speakDenied('group:100200300', [group]), /owner in private is always open/);
});

test('speak-guard: 有人在等她回答时不许发', () => {
  const events = [{ at: NOW - 2 * MIN, type: 'message', chatId: group }];
  assert.match(interjectionDenied(group, events, NOW, 3 * MIN), /waiting for an answer/);
});

test('speak-guard: 刚在同一个聊天说过话，冷却期内不许再发', () => {
  const events = [
    { at: NOW - 20 * MIN, type: 'message', chatId: group },
    { at: NOW - 1 * MIN, type: 'reply', chatId: group },
  ];
  assert.match(interjectionDenied(group, events, NOW, 3 * MIN), /already spoke .* wait 2m/);
});

test('speak-guard: 冷却期过了就放行', () => {
  const events = [
    { at: NOW - 20 * MIN, type: 'message', chatId: group },
    { at: NOW - 10 * MIN, type: 'reply', chatId: group },
  ];
  assert.equal(interjectionDenied(group, events, NOW, 3 * MIN), '');
});

test('speak-guard: 冷却设为 0 时只挡没回的消息', () => {
  const replied = [
    { at: NOW - 20 * MIN, type: 'message', chatId: group },
    { at: NOW - 5_000, type: 'reply', chatId: group },
  ];
  assert.equal(interjectionDenied(group, replied, NOW, 0), '');
});

test('speak-guard: 别的聊天的事件不算数', () => {
  const events = [{ at: NOW - MIN, type: 'message', chatId: 'group:100200300' }];
  assert.equal(interjectionDenied(group, events, NOW, 3 * MIN), '');
});

test('speak-guard: 空 target 把任何私聊都算在自己的范围里', () => {
  const events = [{ at: NOW - MIN, type: 'message', chatId: 'private:1250226509' }];
  assert.match(interjectionDenied('', events, NOW, 3 * MIN), /waiting for an answer/);
  assert.equal(interjectionDenied(group, events, NOW, 3 * MIN), '');
});

test('speak-guard: 事件环形状不对时退化成放行', () => {
  assert.deepEqual(parseSpeakEvents(undefined), []);
  assert.deepEqual(parseSpeakEvents({ list: [{ bad: true }, { at: 1, type: 'message', chatId: group }] }), [
    { at: 1, type: 'message', chatId: group },
  ]);
  assert.equal(interjectionDenied(group, [], NOW, 3 * MIN), '');
});
