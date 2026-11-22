/**
 * 判断记录（run）的纯逻辑：每次「醒来判断一次」留一条账。
 *
 * 一条 run 回答三件事：为什么醒（trigger）、判断结果是什么（decision）、
 * 为什么这么判断（reason）。它是事后复盘与面板展示的唯一依据。
 */
import { randomBytes } from "node:crypto";

export type RunTrigger = "random" | "self" | "manual" | "agreement";
/**
 * 与 whalelife 对齐的九态：
 *   queued      已入队，还没开始
 *   running     正在跑自主回合
 *   settling    回合已结束，正在等待会话落定与观察
 *   completed   正常结算
 *   failed      异常
 *   cancelled   被取消（手动停止/宿主关闭）
 *   interrupted 进程重启时仍在跑的，一律判中断且不重放
 *   uncertain   观察到一半（超时），结论不可信
 *   busy        会话正忙，这次没领到
 */
export type RunStatus =
  | "queued"
  | "running"
  | "settling"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "uncertain"
  | "busy";
export type RunDecision = "acted" | "no_action";

export interface RunRecord {
  id: string;
  sessionId: string;
  trigger: RunTrigger;
  status: RunStatus;
  decision?: RunDecision;
  reason?: string;
  note?: string;
  /** 这一轮读到的心情（总值与档位），读不到就不写。 */
  mood?: string;
  startedAt: string;
  endedAt?: string;
}

export const MAX_RUNS = 20;
export const MAX_REASON = 400;

const TRIGGERS: readonly RunTrigger[] = ["random", "self", "manual", "agreement"];

function newId(): string {
  return randomBytes(6).toString("hex");
}

function truncate(raw: string, limit: number): string {
  const text = raw.trim();
  if (text.length <= limit) return text;
  return Array.from(text).slice(0, limit).join("") + "…";
}

export function isRunTrigger(value: unknown): value is RunTrigger {
  return typeof value === "string" && (TRIGGERS as readonly string[]).includes(value);
}

/**
 * 她还能不能自己收尾。
 *
 * `running` 是常规路径；`settling` 也要放行——唤醒投递成功的那一刻 run 就被打到
 * settling（等会话落定），而她总是这之后才调 `autonomy_finish`。只认 `running`
 * 会把每一次自报的判断都拒掉，账本只能退回观察推断。
 */
export function canFinish(status: RunStatus): boolean {
  return status === "running" || status === "settling";
}

export function isTerminal(status: RunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted" ||
    status === "uncertain"
  );
}

export interface CreateRunInput {
  sessionId: string;
  trigger: RunTrigger;
  note?: string;
  /** 这一轮读到的心情，形如 `mood 42/100 平静`；读不到就不传。 */
  mood?: string;
}

/** 排队一条判断（还没真正执行）。 */
export function createRun(input: CreateRunInput, now: Date, idFactory: () => string = newId): RunRecord {
  return {
    id: idFactory(),
    sessionId: input.sessionId,
    trigger: input.trigger,
    status: "queued",
    ...(input.note?.trim() ? { note: truncate(input.note, 200) } : {}),
    ...(input.mood?.trim() ? { mood: truncate(input.mood, 160) } : {}),
    startedAt: now.toISOString()
  };
}

/** 标记开始执行。 */
export function startRun(run: RunRecord, now: Date): RunRecord {
  if (run.status !== "queued") return run;
  return { ...run, status: "running", startedAt: now.toISOString() };
}

/** 结算一条 run：写入判断结果与理由。 */
export function settleRun(
  run: RunRecord,
  decision: RunDecision,
  reason: string | undefined,
  now: Date,
  status: Extract<RunStatus, "completed" | "failed" | "cancelled" | "interrupted" | "uncertain" | "busy"> =
    "completed"
): RunRecord {
  const next: RunRecord = {
    ...run,
    status,
    decision,
    endedAt: now.toISOString()
  };
  if (reason !== undefined && reason.trim() !== "") next.reason = truncate(reason, MAX_REASON);
  return next;
}

/** 回合跑完、正在等会话落定：这段时间的结论还不算数。 */
export function markSettling(run: RunRecord): RunRecord {
  if (run.status !== "running") return run;
  return { ...run, status: "settling" };
}

/** 进程重启时仍在跑的 run：判中断，且不再重放（whalelife 的 recovery 语义）。 */
export function markInterrupted(run: RunRecord, reason: string, now: Date): RunRecord {
  if (isTerminal(run.status)) return run;
  return {
    ...run,
    status: "interrupted",
    reason: truncate(reason, MAX_REASON),
    endedAt: now.toISOString()
  };
}

/** 未正常结束的 run（超时/异常）。 */
export function failRun(run: RunRecord, reason: string, now: Date): RunRecord {
  return {
    ...run,
    status: "failed",
    reason: truncate(reason, MAX_REASON),
    endedAt: now.toISOString()
  };
}

/** 队列裁剪：保留最近 limit 条；运行中的永远保留。 */
export function trimRuns(runs: readonly RunRecord[], limit: number = MAX_RUNS): RunRecord[] {
  if (runs.length <= limit) return [...runs];
  const running = runs.filter((run) => !isTerminal(run.status));
  const done = runs.filter((run) => isTerminal(run.status));
  const keep = Math.max(0, limit - running.length);
  return [...running, ...done.slice(-keep)].sort(
    (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)
  );
}
