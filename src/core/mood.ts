/**
 * 心情对「这一轮先看什么」的调制。
 *
 * 只动候选的阈值与上限，不动任何节奏：掷骰、间隔、睡眠窗、每日预算全部原样。
 * 也就是说，心情低的时候她不会少醒，只是醒来时眼前摆的东西更少、更紧。
 *
 * 读不到心情一律按「没有」处理——宁可回到原来那一档，也不拿缺省值冒充她的状态。
 */

export interface MoodReading {
  /** 0–100 的总值，aura 心情模块的 `state().value`。 */
  readonly value: number;
  /** 离散档位名，如「平静」，只用于记录与展示。 */
  readonly label: string;
}

export interface MoodTuning {
  readonly threshold: number;
  readonly max: number;
  /** 写进判断记录的一行说明；空串表示这轮没读到心情。 */
  readonly note: string;
}

/** 低于这条线算「情绪偏低」：只挑最要紧的。 */
export const MOOD_LOW = 40;
/** 高于这条线算「情绪偏高」：可以多给一点空间。 */
export const MOOD_HIGH = 75;

const LOW_DELTA = 0.1;
const HIGH_DELTA = 0.05;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 把 aura 心情模块的 `state()` 回包收敛成一个读得懂的两项。 */
export function readMood(raw: unknown): MoodReading | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as { value?: unknown; label?: unknown };
  const value = Number(record.value);
  if (!Number.isFinite(value)) return undefined;
  const label = typeof record.label === 'string' ? record.label.trim() : '';
  return { value: clamp(value, 0, 100), label };
}

/**
 * 心情 → 这一轮的阈值与候选上限。纯函数：同样的读数与基准，结果恒定。
 */
export function moodTuning(
  reading: MoodReading | undefined,
  base: { readonly threshold: number; readonly max: number },
): MoodTuning {
  if (reading === undefined) return { threshold: base.threshold, max: base.max, note: '' };
  const tag = `${round(reading.value)}/100${reading.label === '' ? '' : ` ${reading.label}`}`;
  if (reading.value < MOOD_LOW) {
    return {
      threshold: round(clamp(base.threshold + LOW_DELTA, 0, 1)),
      max: Math.min(base.max, 2),
      note: `mood ${tag} — low, so only the most pressing items are surfaced`,
    };
  }
  if (reading.value > MOOD_HIGH) {
    return {
      threshold: round(clamp(base.threshold - HIGH_DELTA, 0, 1)),
      max: base.max,
      note: `mood ${tag} — high, a little more room is fine`,
    };
  }
  return { threshold: base.threshold, max: base.max, note: `mood ${tag}` };
}
