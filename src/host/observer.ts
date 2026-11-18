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

    if (event.type === 'message/inserted' || event.type === 'message') {
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

/** Last activity epoch in a session log, used as "the user is around" signal. */
export function lastActivityEpoch(events: readonly unknown[]): number | undefined {
  let latest: number | undefined;
  for (const raw of events) {
    const time = (raw as { time?: unknown }).time;
    if (typeof time !== 'string') continue;
    const epoch = Date.parse(time);
    if (!Number.isFinite(epoch)) continue;
    if (latest === undefined || epoch > latest) latest = epoch;
  }
  return latest;
}
