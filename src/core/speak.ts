/**
 * Where autonomy_say may point.
 *
 * This plugin keeps its own allowlist, and it is empty by default: an
 * autonomous turn cannot send anything until the operator names the chats.
 * The aura bot's outbound rules still apply on top — its list, quiet hours,
 * dry run and master switch — but they are a share gate, not a policy: aura
 * also rate-limits by mood and activity, so "aura would allow it" is not the
 * same as "she is allowed to speak". Shape checks stay here too, so a typo
 * fails loudly instead of vanishing into the bridge.
 */

export const SPEAK_TARGET_PATTERN = /^(?:private|group):\d{5,12}$/;

/** True for an empty target (owner in private) or a well-formed address. */
export function isSpeakTarget(value: string): boolean {
  return value === '' || SPEAK_TARGET_PATTERN.test(value);
}

export function malformedTargetMessage(value: string): string {
  return `target must look like group:<qq> or private:<qq>, got: ${value}`;
}

/**
 * The owner's private chat is always reachable — that is the one channel she is
 * meant to have without configuration. The list only adds chats on top of it.
 */
export function speakDenied(target: string, allowed: readonly string[]): string {
  if (target === '') return '';
  if (!isSpeakTarget(target)) return malformedTargetMessage(target);
  if (!allowed.includes(target)) {
    if (target.startsWith('private:')) {
      return `to reach the owner in private, leave target empty — do not fill in any private:<qq>, got: ${target}`;
    }
    return `target not allowed: ${target}（whitelisted chats: ${allowed.length === 0 ? 'none' : allowed.join(', ')}）`;
  }
  return '';
}

/**
 * One event from the aura bot's in-memory ring buffer.
 *
 * The bridge records inbound (`message`) and outbound (`reply`) events with the
 * chat they belong to, which is enough to tell whether a chat is mid-exchange.
 */
export interface SpeakEvent {
  readonly at: number;
  readonly type: string;
  readonly chatId?: string;
}

/** Read `aurabot.events()` output without trusting its shape. */
export function parseSpeakEvents(raw: unknown): SpeakEvent[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const list = (raw as { list?: unknown }).list;
  if (!Array.isArray(list)) return [];
  const out: SpeakEvent[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { at?: unknown; type?: unknown; chatId?: unknown };
    if (typeof record.at !== 'number' || typeof record.type !== 'string') continue;
    out.push({
      at: record.at,
      type: record.type,
      chatId: typeof record.chatId === 'string' ? record.chatId : undefined,
    });
  }
  return out;
}

function agoText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}


/**
 * 空 target 指的是「主人那一条私聊」，不是所有私聊的合桶。
 *
 * 主人的 QQ 没暴露给插件，所以认法是她上一次真正发出去的那条私聊：
 * 最近一条 `reply` 的 chatId 就是主人那条。还没有发出过任何私聊时退回
 * 整个私聊集合——宁可保守，等有人说话就先别发。
 */
function privateScope(privates: readonly SpeakEvent[]): SpeakEvent[] {
  let anchor: string | undefined;
  let anchorAt = -Infinity;
  for (const event of privates) {
    if (event.type !== 'reply' || event.at <= anchorAt) continue;
    anchor = event.chatId;
    anchorAt = event.at;
  }
  if (anchor === undefined) return [...privates];
  return privates.filter((event) => event.chatId === anchor);
}

/**
 * Do not cut into a live exchange.
 *
 * Two cases: the chat is waiting for her (someone spoke and she has not
 * answered yet), or she spoke there a moment ago. Both are re-derived from the
 * ring buffer, so the rule needs no state of its own. An empty target means the
 * owner's private chat; without knowing the owner's QQ, treat every private
 * chat as in scope — being too careful is the safe direction here.
 */
export function interjectionDenied(
  target: string,
  events: readonly SpeakEvent[],
  now: number,
  cooldownMs: number,
): string {
  const privates = events.filter((event) => (event.chatId ?? '').startsWith('private:'));
  const scope = target === ''
    ? privateScope(privates)
    : events.filter((event) => event.chatId === target);
  if (scope.length === 0) return '';

  let lastIn = -Infinity;
  let lastOut = -Infinity;
  for (const event of scope) {
    if (event.type === 'message' && event.at > lastIn) lastIn = event.at;
    if (event.type === 'reply' && event.at > lastOut) lastOut = event.at;
  }

  if (lastIn > lastOut) {
    return `this chat is waiting for an answer (someone spoke ${agoText(now - lastIn)} ago and she has not replied); sending now would cut in — answer it first, or leave it`;
  }
  if (cooldownMs > 0 && lastOut !== -Infinity && now - lastOut < cooldownMs) {
    return `she already spoke in this chat ${agoText(now - lastOut)} ago; wait ${agoText(cooldownMs - (now - lastOut))} more`;
  }
  return '';
}
