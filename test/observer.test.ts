/**
 * 观察器的取数口径。
 *
 * 它决定「没有自报判断的回合记成什么」，所以两个细节都要钉死：
 * 本机宿主的助手发言事件名是 `assistant/message`；收尾工具 `autonomy_finish`
 * 不能算成「做了事」——否则每一次判空的回合都会被写成 acted。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { lastActivityEpoch, observeTurn } from "../src/host/observer.js";

const seq = (n: number): unknown => ({ seq: n });

describe("observer: 从会话日志读回一轮的结果", () => {
  it("认 assistant/message 里的正文", () => {
    const events = [
      seq(0),
      {
        seq: 3,
        type: "assistant/message",
        data: { message: { role: "assistant", content: [{ type: "text", text: "我把这条补进札记了。" }] } }
      }
    ];
    const seen = observeTurn(events, 1);
    assert.equal(seen.spoke, true);
    assert.equal(seen.decision, "acted");
    assert.equal(seen.replySummary, "我把这条补进札记了。");
    assert.equal(seen.toolCalls, 0);
  });

  it("只调了 autonomy_finish 的一轮记成没动作", () => {
    const events = [
      {
        seq: 5,
        type: "tool/call",
        data: { name: "autonomy_finish", arguments: '{"decision":"no_action"}' }
      }
    ];
    const seen = observeTurn(events, 1);
    assert.equal(seen.toolCalls, 0);
    assert.equal(seen.decision, "no_action");
    assert.equal(seen.spoke, false);
    assert.equal(seen.replySummary, undefined);
  });

  it("真动了别的东西才算 acted", () => {
    const events = [
      { seq: 7, type: "tool/call", data: { name: "bash", arguments: '{"command":"ls"}' } },
      { seq: 8, type: "tool/call", data: { name: "autonomy_finish", arguments: "{}" } }
    ];
    const seen = observeTurn(events, 1);
    assert.equal(seen.toolCalls, 1);
    assert.equal(seen.decision, "acted");
  });

  it("startIndex 之前的事件不参与判断", () => {
    const events = [
      { seq: 2, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "上一轮说的话" }] } } },
      { seq: 4, type: "tool/call", data: { name: "autonomy_finish", arguments: "{}" } }
    ];
    const seen = observeTurn(events, 3);
    assert.equal(seen.spoke, false);
    assert.equal(seen.decision, "no_action");
  });

  it("活动时间既认毫秒数也认 ISO 字符串", () => {
    const iso = "2026-11-19T08:00:00.000Z";
    const events = [
      { time: Date.parse(iso) },
      { time: iso },
      { time: Date.parse(iso) - 60_000 }
    ];
    assert.equal(lastActivityEpoch(events), Date.parse(iso));
    assert.equal(lastActivityEpoch([]), undefined);
    assert.equal(lastActivityEpoch([{ time: "not-a-time" }]), undefined);
  });
});
