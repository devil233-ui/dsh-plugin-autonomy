/**
 * Quiet-window gate for messages other plugins push into a session.
 *
 * The scheduler already refuses to *start* a wake inside a sleep window. This
 * gate covers the opposite direction: another plugin (aurabot) pushing a user
 * turn into a managed session while the window is open. The host only sees the
 * message source, so the decision is deliberately narrow:
 *
 *   - only turns that come from aurabot are candidates (`kind === 'aurabot'`)
 *   - inside such a turn, only `speaker.role === 'guest'` is dropped
 *   - `owner` (the human this deployment belongs to), `none` (panel/system
 *     turns) and every other plugin's messages keep flowing
 *
 * Keeping it pure makes the matrix testable without a live host.
 */

export interface IncomingSource {
  readonly kind?: string;
  readonly speaker?: {
    readonly role?: string;
    readonly chat?: string;
  };
}

export interface QuietGateInput {
  readonly source: IncomingSource | undefined;
  readonly sleeping: boolean;
  readonly blockGuest: boolean;
}

/** True when this incoming turn must be dropped instead of delivered. */
export function shouldSuppressIncoming(input: QuietGateInput): boolean {
  if (!input.blockGuest) return false;
  if (!input.sleeping) return false;
  const source = input.source;
  if (source === undefined) return false;
  if (source.kind !== 'aurabot') return false;
  return source.speaker?.role === 'guest';
}

/** Human-readable reason for the log line, or null when nothing is dropped. */
export function suppressReason(input: QuietGateInput): string | null {
  if (!shouldSuppressIncoming(input)) return null;
  const chat = input.source?.speaker?.chat;
  return chat === undefined ? 'sleep window, guest turn' : `sleep window, guest turn from ${chat}`;
}
