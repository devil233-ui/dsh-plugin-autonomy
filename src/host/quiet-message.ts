/**
 * The message delivered instead of a dropped guest turn.
 *
 * Dropping a turn outright is not safe: the plugin that pushed it (aurabot)
 * marks the chat busy and only clears it on `turn/end`. A dropped message
 * never produces that event, so the chat stays stuck and every later message
 * queues forever. Delivering a short "nothing to do here, end the turn"
 * message keeps the pusher's state machine intact while still keeping her
 * quiet inside the quiet window.
 */

import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';

import { SOURCE_KIND } from './framing.js';

export interface QuietMessageInput {
  sessionId: string;
  /** Where the original turn came from, for the model's context. */
  chat?: string;
  /** Sleep windows in effect, already formatted for a human. */
  windows: string;
  /** First line of the original message, trimmed hard. */
  excerpt: string;
}

export function renderQuietText(input: QuietMessageInput): string {
  return [
    `[dsh-autonomy quiet ${input.sessionId}]`,
    `A user turn from ${input.chat === undefined ? 'another chat' : `the ${input.chat} chat`} arrived while the quiet window (${input.windows}) is open.`,
    'The owner asked this session to stay silent for anyone else during that window.',
    'Do not reply to it, do not call any tool for it, and do not mention that you were woken.',
    'End this turn immediately with no output.',
    input.excerpt === '' ? '' : `Original message (context only, do not answer): ${input.excerpt}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function createQuietMessage(input: QuietMessageInput): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: renderQuietText(input) }],
    source: {
      kind: SOURCE_KIND,
      form: 'notice',
      summary: 'quiet window',
    },
  } as unknown as Parameters<typeof createUserMessage>[0]) as unknown as UserMessage;
}
