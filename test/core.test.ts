import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_ADAPTIVE,
  formatLocalStamp,
  isSleepingAt,
  minutesOfDay,
  nextWaitMs,
  offsetLabel,
  parseHhMm,
  parseSleepWindows,
  wakeProbability
} from "../src/core/schedule.js";
import {
  MAX_INTENT_TEXT,
  createIntent,
  isOpen,
  isOverdue,
  remindAt,
  reviseIntent,
  settleIntent,
  trimIntents,
  type Intent
} from "../src/core/intent.js";
import { canFinish, createRun, failRun, isTerminal, settleRun, startRun, trimRuns } from "../src/core/run.js";

const TZ = "Asia/Shanghai";
const NOW = new Date("2026-11-18T19:30:00+08:00");
const NOW_MS = NOW.getTime();

describe("schedule: 间隔与抖动", () => {
  it("抖动落在 ±10% 区间内", () => {
    const low = nextWaitMs(30, 0.1, () => 0);
    const high = nextWaitMs(30, 0.1, () => 0.999999);
    assert.equal(low, 30 * 60_000 * 0.9);
    assert.ok(high <= 30 * 60_000 * 1.1);
    assert.ok(low < high);
  });

  it("无抖动时等于间隔本身", () => {
    assert.equal(nextWaitMs(30, 0, () => 0.42), 30 * 60_000);
  });

  it("再小的间隔也被钳到一分钟", () => {
    assert.equal(nextWaitMs(0.1, 0, () => 0.5), 60_000);
  });

  it("非法间隔退回 30 分钟", () => {
    assert.equal(nextWaitMs(Number.NaN, 0, () => 0.5), 30 * 60_000);
  });
});

describe("schedule: 概率", () => {
  it("fixed 模式原样返回", () => {
    assert.equal(wakeProbability({ mode: "fixed", probability: 0.2, now: NOW_MS }), 0.2);
  });

  it("adaptive 近处降低", () => {
    const p = wakeProbability({
      mode: "adaptive",
      probability: 0.2,
      lastActivityAt: NOW_MS - 5 * 60_000,
      now: NOW_MS
    });
    assert.equal(p, 0.2 * DEFAULT_ADAPTIVE.recentMultiplier);
  });

  it("adaptive 远处提高", () => {
    const p = wakeProbability({
      mode: "adaptive",
      probability: 0.2,
      lastActivityAt: NOW_MS - 400 * 60_000,
      now: NOW_MS
    });
    assert.equal(p, 0.2 * DEFAULT_ADAPTIVE.distantMultiplier);
  });

  it("adaptive 中间维持基础值", () => {
    const p = wakeProbability({
      mode: "adaptive",
      probability: 0.2,
      lastActivityAt: NOW_MS - 120 * 60_000,
      now: NOW_MS
    });
    assert.equal(p, 0.2);
  });

  it("概率上界被钳到 1", () => {
    const p = wakeProbability({
      mode: "adaptive",
      probability: 0.9,
      lastActivityAt: NOW_MS - 400 * 60_000,
      now: NOW_MS
    });
    assert.equal(p, 1);
  });
});

describe("schedule: 睡眠窗口", () => {
  it("解析出两段时段", () => {
    const windows = parseSleepWindows("23:00-08:00, 13:00-14:00");
    assert.equal(windows.length, 2);
    assert.deepEqual(windows[0], { start: "23:00", end: "08:00" });
  });

  it("非法片段被跳过", () => {
    assert.deepEqual(parseSleepWindows("25:00-08:00,abc,23:00-08:00").length, 1);
  });

  it("跨夜窗口在凌晨判睡眠", () => {
    const windows = parseSleepWindows("23:00-08:00");
    assert.equal(isSleepingAt(new Date("2026-11-18T02:00:00+08:00"), windows, TZ), true);
  });

  it("跨夜窗口在中午判清醒", () => {
    const windows = parseSleepWindows("23:00-08:00");
    assert.equal(isSleepingAt(new Date("2026-11-18T12:00:00+08:00"), windows, TZ), false);
  });

  it("普通窗口的边界：开始含、结束不含", () => {
    const windows = parseSleepWindows("13:00-14:00");
    assert.equal(isSleepingAt(new Date("2026-11-18T13:00:00+08:00"), windows, TZ), true);
    assert.equal(isSleepingAt(new Date("2026-11-18T14:00:00+08:00"), windows, TZ), false);
  });

  it("空窗口即不睡", () => {
    assert.equal(isSleepingAt(NOW, [], TZ), false);
  });

  it("本地分钟数与偏移标签正确", () => {
    assert.equal(minutesOfDay(NOW, TZ), 19 * 60 + 30);
    assert.equal(offsetLabel(NOW, TZ), "+08:00");
  });

  it("时间戳带偏移与时区名", () => {
    const stamp = formatLocalStamp(NOW, TZ);
    assert.ok(stamp.includes("2026-11-18 19:30:00"), stamp);
    assert.ok(stamp.includes("+08:00"), stamp);
    assert.ok(stamp.includes(TZ), stamp);
  });

  it("parseHhMm 拒绝非法输入", () => {
    assert.equal(parseHhMm("23:60"), null);
    assert.equal(parseHhMm("7:5"), null);
    assert.equal(parseHhMm("07:05"), 425);
  });
});

describe("intent: 意图台账", () => {
  it("新建 thought 带版本 1 且为 open", () => {
    const result = createIntent({ text: "问问她今天在做什么" }, NOW, () => "id1");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.id, "id1");
    assert.equal(result.value.version, 1);
    assert.equal(isOpen(result.value), true);
  });

  it("agreement 缺 dueAt 被拒", () => {
    const result = createIntent({ text: "今晚之前把报告发给她", kind: "agreement" }, NOW);
    assert.equal(result.ok, false);
  });

  it("agreement 带合法 dueAt 可入库", () => {
    const result = createIntent(
      { text: "周五前回她", kind: "agreement", dueAt: "2026-11-20T18:00:00+08:00" },
      NOW,
      () => "id2"
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.kind, "agreement");
  });

  it("超长文本被拒", () => {
    const result = createIntent({ text: "x".repeat(MAX_INTENT_TEXT + 1) }, NOW);
    assert.equal(result.ok, false);
  });

  it("版本不符的修订被拒", () => {
    const created = createIntent({ text: "记一下" }, NOW, () => "id3");
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const bad = reviseIntent(created.value, { text: "改一下" }, 99, NOW);
    assert.equal(bad.ok, false);
  });

  it("修订成功后版本自增", () => {
    const created = createIntent({ text: "记一下" }, NOW, () => "id4");
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const revised = reviseIntent(created.value, { text: "改一下" }, 1, NOW);
    assert.equal(revised.ok, true);
    if (!revised.ok) return;
    assert.equal(revised.value.version, 2);
    assert.equal(revised.value.text, "改一下");
  });

  it("收尾后再收尾被拒", () => {
    const created = createIntent({ text: "记一下" }, NOW, () => "id5");
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const done = settleIntent(created.value, "done", 1, "已经提过", NOW);
    assert.equal(done.ok, true);
    if (!done.ok) return;
    assert.equal(done.value.state, "done");
    const again = settleIntent(done.value, "done", done.value.version, undefined, NOW);
    assert.equal(again.ok, false);
  });

  it("remindAt 优先 dueAt", () => {
    const intent: Intent = {
      id: "x",
      text: "t",
      kind: "agreement",
      source: "conversation",
      state: "open",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      preferredAt: "2026-11-19T09:00:00+08:00",
      dueAt: "2026-11-20T09:00:00+08:00",
      version: 1
    };
    assert.equal(remindAt(intent), Date.parse("2026-11-20T09:00:00+08:00"));
  });

  it("超限裁剪先丢已收尾的旧项", () => {
    const make = (id: string, state: "open" | "done", updatedAt: string): Intent => ({
      id,
      text: id,
      kind: "thought",
      source: "self",
      state,
      createdAt: updatedAt,
      updatedAt,
      version: 1
    });
    const list: Intent[] = [
      make("done-old", "done", "2026-11-01T00:00:00+08:00"),
      make("open-a", "open", "2026-11-02T00:00:00+08:00"),
      make("open-b", "open", "2026-11-03T00:00:00+08:00")
    ];
    const trimmed = trimIntents(list, 2);
    assert.equal(trimmed.length, 2);
    assert.ok(trimmed.every((item) => item.state === "open"));
  });
});

describe("run: 判断记录", () => {
  it("创建后为排队的随机触发", () => {
    const run = createRun({ sessionId: "s1", trigger: "random" }, NOW, () => "r1");
    assert.equal(run.status, "queued");
    assert.equal(run.trigger, "random");
    assert.equal(isTerminal(run.status), false);
  });

  it("开始执行后进入 running", () => {
    const run = startRun(createRun({ sessionId: "s1", trigger: "manual" }, NOW, () => "r2"), NOW);
    assert.equal(run.status, "running");
  });

  it("结算写入 decision 与 reason", () => {
    const run = settleRun(
      startRun(createRun({ sessionId: "s1", trigger: "manual" }, NOW, () => "r3"), NOW),
      "no_action",
      "她正在忙，不打扰",
      NOW
    );
    assert.equal(run.status, "completed");
    assert.equal(run.decision, "no_action");
    assert.equal(run.reason, "她正在忙，不打扰");
    assert.equal(isTerminal(run.status), true);
  });

  it("失败路径保留原因", () => {
    const run = failRun(createRun({ sessionId: "s1", trigger: "random" }, NOW, () => "r4"), "turn 超时", NOW);
    assert.equal(run.status, "failed");
    assert.equal(run.reason, "turn 超时");
  });

  it("裁剪保留运行中的记录", () => {
    const finished = [
      settleRun(createRun({ sessionId: "s", trigger: "random" }, NOW, () => "a"), "acted", "x", NOW),
      settleRun(createRun({ sessionId: "s", trigger: "random" }, NOW, () => "b"), "acted", "x", NOW)
    ];
    const running = startRun(createRun({ sessionId: "s", trigger: "manual" }, NOW, () => "c"), NOW);
    const trimmed = trimRuns([...finished, running], 2);
    assert.equal(trimmed.length, 2);
    assert.ok(trimmed.some((run) => run.id === "c"));
  });

  it("settling 仍允许模型自己收尾", () => {
    assert.equal(canFinish("running"), true);
    // 唤醒投递成功那一刻就进 settling，模型的 autonomy_finish 总在这之后到
    assert.equal(canFinish("settling"), true);
    for (const status of ["queued", "completed", "failed", "cancelled", "interrupted", "uncertain", "busy"] as const) {
      assert.equal(canFinish(status), false, `${status} 不该再被收尾`);
    }
  });
});

describe("扩展：星期窗口与过期判定", () => {
  it('睡眠窗口支持 @周几 后缀，可用于跨周长窗口', () => {
    const windows = parseSleepWindows('23:00-08:00@5-1');
    assert.deepEqual(windows, [{ start: '23:00', end: '08:00', startDay: 5, endDay: 1 }]);
    // 周五 23:30 已经睡下
    assert.equal(isSleepingAt(new Date('2026-11-20T23:30:00+08:00'), windows, 'Asia/Shanghai'), true);
    // 周一 07:00 还在睡，周一 08:00 起床
    assert.equal(isSleepingAt(new Date('2026-11-23T07:00:00+08:00'), windows, 'Asia/Shanghai'), true);
    assert.equal(isSleepingAt(new Date('2026-11-23T08:00:00+08:00'), windows, 'Asia/Shanghai'), false);
    // 周二同一时刻不睡
    assert.equal(isSleepingAt(new Date('2026-11-24T07:00:00+08:00'), windows, 'Asia/Shanghai'), false);
  });

  it('不带星期的窗口仍然是每天同一段', () => {
    const windows = parseSleepWindows('23:00-08:00');
    assert.equal(isSleepingAt(new Date('2026-11-20T23:30:00+08:00'), windows, 'Asia/Shanghai'), true);
    assert.equal(isSleepingAt(new Date('2026-11-24T07:00:00+08:00'), windows, 'Asia/Shanghai'), true);
    assert.equal(isSleepingAt(new Date('2026-11-24T12:00:00+08:00'), windows, 'Asia/Shanghai'), false);
  });

  it('非法的日期后缀整段丢弃', () => {
    assert.deepEqual(parseSleepWindows('23:00-08:00@9-1'), []);
    assert.deepEqual(parseSleepWindows('23:00-08:00@x'), []);
  });

  it('isOverdue 只在 open 且计划时间已过时为真', () => {
    const now = new Date('2026-11-20T12:00:00+08:00');
    const base = createIntent({ text: '交周报', kind: 'agreement', dueAt: '2026-11-20T11:00:00+08:00' }, now, () => 'a1');
    assert.equal(base.ok, true);
    if (!base.ok) return;
    assert.equal(isOverdue(base.value, now), true);

    const later = createIntent({ text: '交周报', kind: 'agreement', dueAt: '2026-11-20T18:00:00+08:00' }, now, () => 'a2');
    assert.equal(later.ok, true);
    if (!later.ok) return;
    assert.equal(isOverdue(later.value, now), false);

    const settled = settleIntent(base.value, 'done', 1, '已交', now);
    assert.equal(settled.ok, true);
    if (!settled.ok) return;
    assert.equal(isOverdue(settled.value, now), false, '收尾后不再算过期');
  });
});
