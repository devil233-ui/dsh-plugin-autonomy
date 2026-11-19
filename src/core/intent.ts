/**
 * 意图台账的纯逻辑：她惦记什么、答应过谁、什么时候该提。
 *
 * 与 astrbot autonomy 对齐的两条硬规则：
 *   - agreement（约定/承诺）必须有 dueAt，否则拒绝入库；
 *   - 任何修改都要带期望版本号，版本不符即拒绝，防止旧快照覆盖新状态。
 */
import { randomBytes } from "node:crypto";

export type IntentKind = "thought" | "agreement";
export type IntentSource = "self" | "conversation";
export type IntentState = "open" | "done" | "abandoned";

export interface Intent {
  id: string;
  text: string;
  kind: IntentKind;
  source: IntentSource;
  state: IntentState;
  createdAt: string;
  updatedAt: string;
  preferredAt?: string;
  dueAt?: string;
  reason?: string;
  version: number;
  /** 攒起来的冷度：连续几轮没动手就往上涨，动手就清零。 */
  chill?: number;
  /** 冷度到顶后的暂停期；到期自动解冻，不必人工放行。 */
  parkedUntil?: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const MAX_INTENTS = 50;
/** 每一轮「开到眼前却没动手」加多少冷度。 */
export const CHILL_PER_MISS = 0.5;
/** 冷度到这里就暂停（0.5 × 4 轮）。 */
export const CHILL_PARK_AT = 2;
/** 暂停多久，到期自己解冻。 */
export const PARK_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_INTENT_TEXT = 500;

function newId(): string {
  return randomBytes(5).toString("hex");
}

function parseInstant(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Date.parse(raw);
  return Number.isFinite(value) ? value : null;
}

function trimText(raw: string): string {
  return raw.trim();
}

export interface CreateIntentInput {
  text: string;
  kind?: IntentKind;
  source?: IntentSource;
  preferredAt?: string;
  dueAt?: string;
  reason?: string;
}

/** 新建一条意图。kind=agreement 时 dueAt 必填且须是合法时间。 */
export function createIntent(input: CreateIntentInput, now: Date, idFactory: () => string = newId): Result<Intent> {
  const text = trimText(input.text ?? "");
  if (text === "") return { ok: false, error: "text 不能为空" };
  if (text.length > MAX_INTENT_TEXT) return { ok: false, error: `text 超过 ${MAX_INTENT_TEXT} 字` };
  const kind: IntentKind = input.kind ?? "thought";
  const source: IntentSource = input.source ?? "self";
  const dueAt = input.dueAt?.trim();
  if (kind === "agreement") {
    if (dueAt === undefined || dueAt === "") return { ok: false, error: "约定类意图必须带 dueAt（计划时间）" };
    if (parseInstant(dueAt) === null) return { ok: false, error: "dueAt 不是合法时间" };
  }
  const preferredAt = input.preferredAt?.trim();
  if (preferredAt !== undefined && preferredAt !== "" && parseInstant(preferredAt) === null) {
    return { ok: false, error: "preferredAt 不是合法时间" };
  }
  const stamp = now.toISOString();
  return {
    ok: true,
    value: {
      id: idFactory(),
      text,
      kind,
      source,
      state: "open",
      createdAt: stamp,
      updatedAt: stamp,
      ...(preferredAt !== undefined && preferredAt !== "" ? { preferredAt } : {}),
      ...(dueAt !== undefined && dueAt !== "" ? { dueAt } : {}),
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
      version: 1
    }
  };
}

export interface IntentPatch {
  text?: string;
  preferredAt?: string | null;
  dueAt?: string | null;
  reason?: string;
}

/** 修订一条仍处于 open 的意图；版本不符或已收尾即拒绝。 */
export function reviseIntent(intent: Intent, patch: IntentPatch, expectedVersion: number, now: Date): Result<Intent> {
  if (intent.state !== "open") return { ok: false, error: `意图已收尾（${intent.state}），不能再改` };
  if (intent.version !== expectedVersion) {
    return { ok: false, error: `版本不符：当前 ${intent.version}，期望 ${expectedVersion}` };
  }
  const next: Intent = { ...intent, updatedAt: now.toISOString(), version: intent.version + 1 };
  if (patch.text !== undefined) {
    const text = trimText(patch.text);
    if (text === "") return { ok: false, error: "text 不能为空" };
    if (text.length > MAX_INTENT_TEXT) return { ok: false, error: `text 超过 ${MAX_INTENT_TEXT} 字` };
    next.text = text;
  }
  if (patch.preferredAt !== undefined) {
    if (patch.preferredAt === null) delete next.preferredAt;
    else {
      if (parseInstant(patch.preferredAt) === null) return { ok: false, error: "preferredAt 不是合法时间" };
      next.preferredAt = patch.preferredAt;
    }
  }
  if (patch.dueAt !== undefined) {
    if (patch.dueAt === null) {
      if (intent.kind === "agreement") return { ok: false, error: "约定类意图不能清空 dueAt" };
      delete next.dueAt;
    } else {
      if (parseInstant(patch.dueAt) === null) return { ok: false, error: "dueAt 不是合法时间" };
      next.dueAt = patch.dueAt;
    }
  }
  if (patch.reason !== undefined) {
    if (patch.reason.trim() === "") delete next.reason;
    else next.reason = patch.reason.trim();
  }
  return { ok: true, value: next };
}

/** 收尾：done（提过/做完了）或 abandoned（不再惦记）。 */
export function settleIntent(
  intent: Intent,
  state: "done" | "abandoned",
  expectedVersion: number,
  reason: string | undefined,
  now: Date
): Result<Intent> {
  if (intent.state !== "open") return { ok: false, error: `意图已收尾（${intent.state}），不能重复收尾` };
  if (intent.version !== expectedVersion) {
    return { ok: false, error: `版本不符：当前 ${intent.version}，期望 ${expectedVersion}` };
  }
  const next: Intent = {
    ...intent,
    state,
    updatedAt: now.toISOString(),
    version: intent.version + 1
  };
  if (reason !== undefined && reason.trim() !== "") next.reason = reason.trim();
  return { ok: true, value: next };
}

/** 还在暂停期里就不该再排到眼前。 */
export function isParked(intent: Intent, now: number): boolean {
  if (intent.parkedUntil === undefined) return false;
  const until = Date.parse(intent.parkedUntil);
  return Number.isFinite(until) && until > now;
}

/**
 * 记一次「开到眼前但没动手」。冷度到顶就 park 一段时间；暂停期已过的
 * 旧冷度先清掉再重新计，免得刚解冻就被下一轮立刻再关进去。
 */
export function recordMiss(intent: Intent, now: Date): Intent {
  const fresh = !isParked(intent, now.getTime()) && intent.parkedUntil !== undefined ? 0 : (intent.chill ?? 0);
  const chill = Number((fresh + CHILL_PER_MISS).toFixed(2));
  const next: Intent = { ...intent, chill };
  if (chill >= CHILL_PARK_AT) {
    next.parkedUntil = new Date(now.getTime() + PARK_MS).toISOString();
  } else {
    delete next.parkedUntil;
  }
  return next;
}

/** 记一次真的动了手：冷度清零，暂停解除。 */
export function recordHit(intent: Intent, now: Date): Intent {
  const next: Intent = { ...intent, updatedAt: now.toISOString() };
  delete next.chill;
  delete next.parkedUntil;
  return next;
}

export function isOpen(intent: Intent): boolean {
  return intent.state === "open";
}

/**
 * 已到计划时间却还没收尾：唤醒文案要说"已到计划时间，仍未完成"，
 * 而不是继续显示一个已经过去的时间点。
 */
export function isOverdue(intent: Intent, now: Date): boolean {
  if (intent.state !== "open") return false;
  const at = remindAt(intent);
  return at !== undefined && at <= now.getTime();
}

/** 该意图最该被提起的时刻（dueAt 优先，其次 preferredAt）；没有则 undefined。 */
export function remindAt(intent: Intent): number | undefined {
  const due = parseInstant(intent.dueAt);
  if (due !== null) return due;
  const preferred = parseInstant(intent.preferredAt);
  return preferred === null ? undefined : preferred;
}

/** 把一批意图裁到上限，先丢最旧的已收尾项。 */
export function trimIntents(intents: readonly Intent[], limit: number = MAX_INTENTS): Intent[] {
  const list = [...intents];
  if (list.length <= limit) return list;
  const closed = list
    .map((intent, index) => ({ intent, index }))
    .filter((row) => row.intent.state !== "open")
    .sort((a, b) => Date.parse(a.intent.updatedAt) - Date.parse(b.intent.updatedAt));
  const drop = new Set<number>();
  for (const row of closed) {
    if (list.length - drop.size <= limit) break;
    drop.add(row.index);
  }
  return list.filter((_, index) => !drop.has(index));
}
