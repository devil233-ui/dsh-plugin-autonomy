/**
 * Read a settled autonomous turn off the session log.
 *
 * The plugin does not trust the model's own claim about what happened; it
 * looks at what the turn actually committed. `autonomy_finish` supplies the
 * authored reason, and this module supplies the observed decision when the
 * model did not call it at all (silence is a legitimate outcome, but it still
 * has to be recorded).
 */

export type ObservedDecision = 'acted' | 'no_action';

export interface TurnObservation {
  decision: ObservedDecision;
  /** Assistant text seen in the turn, trimmed to a short summary. */
  replySummary?: string;
  /** Number of tool calls the turn committed. */
  toolCalls: number;
  /** Whether the turn produced any assistant text at all. */
  spoke: boolean;
}

interface MinimalBlock {
  type?: unknown;
  text?: unknown;
}

interface MinimalEvent {
  type?: unknown;
  data?: unknown;
  seq?: unknown;
}

function blocksOf(value: unknown): MinimalBlock[] {
  return Array.isArray(value) ? (value as MinimalBlock[]) : [];
}

function textOf(blocks: readonly MinimalBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
    .trim();
}

/**
 * 记账用的工具，不算「做了事」。
 *
 * 模型收尾时一定要调 `autonomy_finish`，它本身也是一次 tool/call；把它算进动作，
 * 会让每一个判空的回合都被记成 acted。
 */
const BOOKKEEPING_TOOLS = new Set(['autonomy_finish']);

/**
 * Analyze events from `startIndex` (the session seq before the wake was
 * delivered). Assistant messages and tool calls both count as action; a turn
 * that committed neither is recorded as `no_action`.
 */
export function observeTurn(events: readonly unknown[], startIndex: number): TurnObservation {
  let toolCalls = 0;
  let replySummary: string | undefined;
  let spoke = false;

  for (const raw of events) {
    const event = raw as MinimalEvent;
    const seq = typeof event.seq === 'number' ? event.seq : undefined;
    if (seq !== undefined && seq < startIndex) continue;
    const data = (event.data ?? {}) as Record<string, unknown>;

    // 本机 DSH 把助手发言记成 `assistant/message`；`message/inserted` 与 `message`
    // 是别的宿主线/注入消息的写法，一起认。
    if (event.type === 'message/inserted' || event.type === 'message' || event.type === 'assistant/message') {
      const message = (data.message ?? data) as Record<string, unknown>;
      if (message.role === 'assistant') {
        const text = textOf(blocksOf(message.content));
        if (text !== '') {
          spoke = true;
          if (replySummary === undefined) replySummary = text.slice(0, 200);
        }
      }
      continue;
    }

    if (event.type === 'tool/call' || event.type === 'tool/started' || event.type === 'tool_call') {
      const name = typeof data.name === 'string' ? data.name : '';
      if (BOOKKEEPING_TOOLS.has(name)) continue;
      toolCalls += 1;
    }
  }

  return {
    decision: spoke || toolCalls > 0 ? 'acted' : 'no_action',
    ...(replySummary === undefined ? {} : { replySummary }),
    toolCalls,
    spoke,
  };
}

/**
 * Last activity epoch in a session log, used as "the user is around" signal.
 *
 * 本机宿主把 `time` 写成毫秒数，别的线可能写 ISO 字符串，两种都认；
 * 只认字符串会让「刚有人说话就别来打扰」这条静默判断永远拿不到时间。
 */
export function lastActivityEpoch(events: readonly unknown[]): number | undefined {
  let latest: number | undefined;
  for (const raw of events) {
    const time = (raw as { time?: unknown }).time;
    const epoch = typeof time === 'number' ? time : typeof time === 'string' ? Date.parse(time) : Number.NaN;
    if (!Number.isFinite(epoch)) continue;
    if (latest === undefined || epoch > latest) latest = epoch;
  }
  return latest;
}
