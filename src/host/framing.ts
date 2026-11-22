/**
 * The message that starts an autonomous turn.
 *
 * It is a user-role message, because that is the only role that can start a
 * turn, but it carries a producer-owned `notice` source so the GUI renders it
 * as a context chip rather than a user bubble, and so the model can tell it
 * apart from a real person talking. The text states that fact explicitly and
 * lists the three ways the turn can end — speak, act, or stay silent — then
 * asks for the `autonomy_finish` bookkeeping call.
 */

import { boundContextSummary, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';

import { formatLocalStamp } from '../core/schedule.js';

export const PLUGIN_NAME = 'dsh-autonomy';
export const SOURCE_KIND = `plugin:${PLUGIN_NAME}`;
export const FRAMING_MARKER = '[dsh-autonomy wake ';

export type WakeTrigger = 'random' | 'self' | 'agreement' | 'manual';

export interface FramingInput {
  runId: string;
  sessionId: string;
  trigger: WakeTrigger;
  now: Date;
  /** Why this roll woke the session (probability value, self-note, …). */
  note?: string;
  /** Open intents rendered into the prompt so the model need not re-read them. */
  openIntents: readonly { text: string; kind: string; dueAt?: string; overdue?: boolean }[];
  timeZone: string;
  /** Replaces the built-in "decide what to do" paragraph when non-empty. */
  motivation?: string;
  /** Chats the operator whitelisted. Empty means this turn cannot send at all. */
  speakTargets?: readonly string[];
  /** Scored intents for this moment, highest first. Empty means nothing cleared the bar. */
  candidates?: readonly { text: string; kind: string; score: number; why: string }[];
  /** 记忆库按这一轮的素材捞回来的旧事；空串等于这轮没有。 */
  memories?: string;
  /** 她日记里的愿望：不是待办，只摆出来，附原文路径供回看。 */
  wishes?: readonly { text: string; day: string; source: string }[];
}

/**
 * Notice-form producer source. The cast is needed because the published
 * `dsh-llm` types still model the retired v3 `{kind:'plugin'}` wrapper as the
 * only plugin source, while the v4 write path requires a producer-owned kind.
 */
export function autonomyNoticeSource(summary: string): UserMessage['source'] {
  return {
    kind: SOURCE_KIND,
    form: 'notice',
    summary: boundContextSummary(summary),
  } as unknown as UserMessage['source'];
}

function intentLine(intent: FramingInput['openIntents'][number], timeZone: string): string {
  const parts = [`- [${intent.kind}] ${intent.text}`];
  if (intent.dueAt !== undefined) {
    const stamp = formatLocalStamp(new Date(intent.dueAt), timeZone);
    parts.push(
      intent.overdue === true
        ? `(was due ${stamp}; that time has passed and it is still open)`
        : `(due ${stamp})`,
    );
  }
  return parts.join(' ');
}

/** Render the framing text. Kept small: it is paid on every wake. */
export function renderFramingText(input: FramingInput): string {
  const lines: string[] = [];
  lines.push(`${FRAMING_MARKER}${input.runId} ${input.trigger} session=${input.sessionId}]`);
  lines.push(`Now ${formatLocalStamp(input.now, input.timeZone)}.`);
  lines.push('This is a scheduled self-check from the autonomy plugin, not a message from the user.');
  if (input.note !== undefined && input.note.trim() !== '') {
    lines.push(`Reason for this wake: ${input.note.trim()}`);
  }
  if (input.openIntents.length > 0) {
    lines.push('Open intents you left for yourself:');
    // 上游 whalelife 的 intent-visibility 契约：未完成意图必须全部可见，
    // 所以这里不再截断，只受台账上限（MAX_INTENTS=50）约束。
    for (const intent of input.openIntents) lines.push(intentLine(intent, input.timeZone));
  }
  const wishes = input.wishes ?? [];
  if (wishes.length > 0) {
    lines.push(
      'Wishes you wrote down in your diary. These are not todos — some may take a long time, some may never happen, and nothing here is expected of you. The bracketed path is the diary entry they came from, if you want the original:',
    );
    for (const wish of wishes) {
      const day = wish.day.trim();
      const source = wish.source.trim();
      const where = source === '' ? '' : ` — ${source}${day === '' ? '' : ` (${day})`}`;
      lines.push(`- ${wish.text}${where}`);
    }
  }
  const memories = input.memories?.trim() ?? '';
  if (memories !== '') {
    lines.push('From your memory library (found by a keyword lookup on the items above; it can be stale or misremembered — what is happening now outranks it, and do not quote it back verbatim):');
    for (const line of memories.split('\n')) {
      const text = line.trim();
      if (text !== '') lines.push(`  ${text}`);
    }
  }
  const candidates = input.candidates ?? [];
  if (candidates.length > 0) {
    lines.push(
      'Ranked by a fixed formula this plugin can recompute (clock, novelty against what you already did, provenance, commitment). It is an ordering, not an order:',
    );
    for (const candidate of candidates) {
      lines.push(`- ${candidate.score.toFixed(2)} [${candidate.kind}] ${candidate.text} — ${candidate.why}`);
    }
    if (input.openIntents.length > candidates.length) {
      lines.push('Everything else on the list above is still open; it just scored lower at this moment.');
    }
  }
  lines.push('');
  const motivation = input.motivation?.trim() ?? '';
  if (motivation !== '') {
    lines.push(motivation);
  } else {
    lines.push('Decide what to do with this moment:');
    lines.push('- speak to the user if there is something genuinely worth saying;');
    lines.push('- act on something useful (a task, a file, a check) if that is better;');
    lines.push('- or do nothing, which is a valid and expected outcome.');
  }
  lines.push(
    'You may also record an intent for later with autonomy_intents, or schedule your own wake with autonomy_schedule.',
  );
  const speakTargets = input.speakTargets ?? [];
  if (speakTargets.length === 0) {
    lines.push(
      'The owner in private is always reachable: autonomy_say({ text }) without a target. No other chat is whitelisted, so do not name one. Work inside the workspace, or leave a note as an intent for when a channel opens.',
    );
  } else {
    lines.push(
      `If speaking is the right move, use autonomy_say({ text }) to message the owner in private (always open), or autonomy_say({ target, text }) with one of the whitelisted chats: ${speakTargets.join(', ')}. A chat outside that list is refused before it reaches the bot. Two more refusals: a chat where someone is still waiting for her answer, and the same chat again inside the cooldown window. The aura bot applies its own rules on top and reports back what happened.`,
    );
  }
  lines.push(
    'End this turn with autonomy_finish(run_id, decision, reason): decision is "acted" or "no_action", reason is one short sentence.',
  );
  return lines.join('\n');
}

/** Build the wire message for one autonomous turn. */
export function createFramingMessage(input: FramingInput): UserMessage {
  const text = renderFramingText(input);
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: autonomyNoticeSource(`autonomy ${input.trigger} check`),
  });
}
