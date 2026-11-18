/**
 * 判断记录（run）的纯逻辑：每次「醒来判断一次」留一条账。
 *
 * 一条 run 回答三件事：为什么醒（trigger）、判断结果是什么（decision）、
 * 为什么这么判断（reason）。它是事后复盘与面板展示的唯一依据。
 */
import { randomBytes } from "node:crypto";

export type RunTrigger = "random" | "self" | "manual" | "agreement";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type RunDecision = "acted" | "no_action";

export interface RunRecord {
  id: string;
  sessionId: string;
  trigger: RunTrigger;
  status: RunStatus;
  decision?: RunDecision;
  reason?: string;
  note?: string;
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

export function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export interface CreateRunInput {
  sessionId: string;
  trigger: RunTrigger;
  note?: string;
}

/** 排队一条判断（还没真正执行）。 */
export function createRun(input: CreateRunInput, now: Date, idFactory: () => string = newId): RunRecord {
  return {
    id: idFactory(),
    sessionId: input.sessionId,
    trigger: input.trigger,
    status: "queued",
    ...(input.note?.trim() ? { note: truncate(input.note, 200) } : {}),
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
  status: Extract<RunStatus, "completed" | "failed" | "cancelled"> = "completed"
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
