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

/** Empty list = nothing may be sent. Otherwise: shape first, then membership. */
export function speakDenied(target: string, allowed: readonly string[]): string {
  if (allowed.length === 0) {
    return 'no chat is whitelisted, so nothing may be sent (设置里的说话去处是空的)';
  }
  if (target === '') return 'target is required: name one of the whitelisted chats (group:<qq> / private:<qq>)';
  if (!isSpeakTarget(target)) return malformedTargetMessage(target);
  if (!allowed.includes(target)) return `target not allowed: ${target}（allowed: ${allowed.join(', ')}）`;
  return '';
}
