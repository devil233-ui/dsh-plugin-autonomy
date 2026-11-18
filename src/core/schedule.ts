/**
 * 纯逻辑：节律、概率、睡眠窗口。不 import 任何 @deepseek-ai/*，可在裸 Node 下单测。
 *
 * 语义来源是 AstrBot autonomy：插件按平均间隔掷一次骰，实际等待在间隔附近抖动；
 * 每次检查按概率决定醒不醒；睡眠时段内不醒。
 */

/** 一次等待的下限：再短的间隔也不至于把宿主叫成忙线。 */
export const MIN_WAIT_MS = 60_000;

/**
 * 一个睡眠时段，`HH:mm` 表示本地时钟；start > end 表示跨夜。
 *
 * 带 startDay/endDay（0=周日 … 6=周六）时表示"从周几几点到周几几点"，
 * 支持跨周（如周五 23:00 → 周一 08:00）。两者缺省即每天同一段。
 */
export interface SleepWindow {
  start: string;
  end: string;
  startDay?: number;
  endDay?: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** `now` 在指定时区里是周几（0=周日 … 6=周六）。 */
export function weekdayIndex(now: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(now);
  return WEEKDAY_INDEX[name] ?? 0;
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
 * 解析 `HH:mm-HH:mm[,HH:mm-HH:mm…]` 形式的睡眠时段。
 *
 * 每段可带 `@startDay-endDay` 后缀（0=周日 … 6=周六；7 视作周日），
 * 例如 `23:00-08:00@5-1` 是"周五 23:00 到周一 08:00"。
 * 非法片段直接跳过（宁可少一段睡眠，也不因一条坏配置让插件拒绝启动）。
 */
export function parseSleepWindows(raw: string): SleepWindow[] {
  const windows: SleepWindow[] = [];
  for (const chunk of raw.split(",")) {
    const segment = chunk.trim();
    if (segment === "") continue;

    const [clockPart = "", dayPart] = segment.split("@");
    const dash = clockPart.indexOf("-");
    if (dash <= 0) continue;
    const start = clockPart.slice(0, dash).trim();
    const end = clockPart.slice(dash + 1).trim();
    if (parseHhMm(start) === null || parseHhMm(end) === null) continue;

    const window: SleepWindow = { start, end };
    if (dayPart !== undefined) {
      const days = parseDayRange(dayPart.trim());
      if (days === null) continue;
      window.startDay = days[0];
      window.endDay = days[1];
    }
    windows.push(window);
  }
  return windows;
}

/** `1-5` → [1,5]；单个 `1` → [1,1]；非法返回 null。 */
function parseDayRange(raw: string): [number, number] | null {
  const pick = (text: string): number | null => {
    if (!/^\d$/.test(text)) return null;
    const value = Number(text);
    // 只接受 0-6（周日…周六）与 7（等同周日），其余一律当坏配置。
    if (!Number.isInteger(value) || value < 0 || value > 7) return null;
    return value % 7;
  };
  const dash = raw.indexOf("-");
  if (dash < 0) {
    const only = pick(raw);
    return only === null ? null : [only, only];
  }
  const start = pick(raw.slice(0, dash).trim());
  const end = pick(raw.slice(dash + 1).trim());
  return start === null || end === null ? null : [start, end];
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
  const day = weekdayIndex(now, timeZone);
  for (const window of windows) {
    const start = parseHhMm(window.start);
    const end = parseHhMm(window.end);
    if (start === null || end === null || start === end) continue;

    if (window.startDay === undefined && window.endDay === undefined) {
      // 每天同一段：只在当日时钟上判断。
      if (start < end) {
        if (current >= start && current < end) return true;
      } else if (current >= start || current < end) {
        return true;
      }
      continue;
    }

    // 带星期的窗口按"周内分钟"判断，因此能表达跨周的长窗口。
    const startDay = window.startDay ?? window.endDay ?? day;
    const endDay = window.endDay ?? window.startDay ?? day;
    const startIndex = startDay * 1440 + start;
    const endIndex = endDay * 1440 + end;
    const nowIndex = day * 1440 + current;
    if (startIndex <= endIndex) {
      if (nowIndex >= startIndex && nowIndex < endIndex) return true;
    } else if (nowIndex >= startIndex || nowIndex < endIndex) {
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
