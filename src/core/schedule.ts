/**
 * 纯逻辑：节律、概率、睡眠窗口。不 import 任何 @deepseek-ai/*，可在裸 Node 下单测。
 *
 * 语义来源是 AstrBot autonomy：插件按平均间隔掷一次骰，实际等待在间隔附近抖动；
 * 每次检查按概率决定醒不醒；睡眠时段内不醒。
 */

/** 一次等待的下限：再短的间隔也不至于把宿主叫成忙线。 */
export const MIN_WAIT_MS = 60_000;

/** 一个睡眠时段，`HH:mm` 表示本地时钟；start > end 表示跨夜。 */
export interface SleepWindow {
  start: string;
  end: string;
}

/** 自适应概率的四个旋钮：离上次活动近则降低，久则提高。 */
export interface AdaptiveOptions {
  recentMinutes: number;
  recentMultiplier: number;
  distantMinutes: number;
  distantMultiplier: number;
}

export const DEFAULT_ADAPTIVE: AdaptiveOptions = {
  recentMinutes: 20,
  recentMultiplier: 0.15,
  distantMinutes: 360,
  distantMultiplier: 1.5
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** 把 `HH:mm` 解析成当日分钟数；非法返回 null。 */
export function parseHhMm(raw: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (m === null) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * 解析 `HH:mm-HH:mm,HH:mm-HH:mm` 形式的睡眠时段。
 * 非法片段直接跳过（宁可少一段睡眠，也不因一条坏配置让插件拒绝启动）。
 */
export function parseSleepWindows(raw: string): SleepWindow[] {
  const windows: SleepWindow[] = [];
  for (const chunk of raw.split(",")) {
    const segment = chunk.trim();
    if (segment === "") continue;
    const dash = segment.indexOf("-");
    if (dash <= 0) continue;
    const start = segment.slice(0, dash).trim();
    const end = segment.slice(dash + 1).trim();
    if (parseHhMm(start) === null || parseHhMm(end) === null) continue;
    windows.push({ start, end });
  }
  return windows;
}

/**
 * 下一次检查的等待毫秒数。
 * @param intervalMinutes 平均间隔（分钟）
 * @param jitterRatio 抖动比例，0.1 表示 ±10%
 * @param random 取 [0,1) 的随机源，测试注入固定值
 */
export function nextWaitMs(intervalMinutes: number, jitterRatio: number, random: () => number): number {
  const minutes = Number.isFinite(intervalMinutes) ? Math.max(1, intervalMinutes) : 30;
  const base = minutes * 60_000;
  const jitter = clamp01(jitterRatio);
  const factor = 1 + (random() * 2 - 1) * jitter;
  return Math.max(MIN_WAIT_MS, Math.round(base * factor));
}

export interface ProbabilityInput {
  mode: "fixed" | "adaptive";
  probability: number;
  /** 该会话最后一次活动的时间戳（毫秒）；没有记录时按基础概率。 */
  lastActivityAt?: number;
  now: number;
  adaptive?: AdaptiveOptions;
}

/**
 * 本次检查真正醒来的概率。
 * fixed：原样；adaptive：距上次活动越近越低、越久越高，中间回到基础值。
 */
export function wakeProbability(input: ProbabilityInput): number {
  const base = clamp01(input.probability);
  if (input.mode === "fixed") return base;
  const adaptive = input.adaptive ?? DEFAULT_ADAPTIVE;
  if (input.lastActivityAt === undefined) return base;
  const idleMinutes = Math.max(0, (input.now - input.lastActivityAt) / 60_000);
  if (idleMinutes < adaptive.recentMinutes) return clamp01(base * adaptive.recentMultiplier);
  if (idleMinutes >= adaptive.distantMinutes) return clamp01(base * adaptive.distantMultiplier);
  return base;
}

/** `now` 在指定时区里的当日分钟数。 */
export function minutesOfDay(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return ((hour % 24) * 60 + minute) % 1440;
}

/** `now` 是否落在任一睡眠时段内；空列表即不睡。 */
export function isSleepingAt(now: Date, windows: readonly SleepWindow[], timeZone: string): boolean {
  if (windows.length === 0) return false;
  const current = minutesOfDay(now, timeZone);
  for (const window of windows) {
    const start = parseHhMm(window.start);
    const end = parseHhMm(window.end);
    if (start === null || end === null || start === end) continue;
    if (start < end) {
      if (current >= start && current < end) return true;
    } else if (current >= start || current < end) {
      return true;
    }
  }
  return false;
}

/** 形如 `+08:00` 的本地偏移标签。 */
export function offsetLabel(now: Date, timeZone: string): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")?.value;
  if (name === undefined || name === "GMT") return "+00:00";
  return name.replace(/^GMT/, "");
}

/**
 * 给模型看的本地时间，形如 `2026-11-18 19:30:00 (+08:00, Asia/Shanghai)`。
 * 只用于唤醒文案与记录，不参与判断。
 */
export function formatLocalStamp(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(now);
  const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? "00";
  const hour = pick("hour") === "24" ? "00" : pick("hour");
  return `${pick("year")}-${pick("month")}-${pick("day")} ${hour}:${pick("minute")}:${pick("second")} (${offsetLabel(now, timeZone)}, ${timeZone})`;
}
