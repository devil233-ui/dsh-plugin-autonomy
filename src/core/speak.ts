/**
 * Where autonomy_say may point.
 *
 * The plugin deliberately does not keep an allowlist any more: picking the room
 * is her judgement, and whether a message may leave at all is decided by the
 * aura bot's own outbound rules (its `allow` lists, quiet hours, dry run and
 * master switch). What autonomy still checks is shape — a target has to be a
 * real address form, so a typo fails loudly here instead of silently vanishing
 * into the bridge.
 */

export const SPEAK_TARGET_PATTERN = /^(?:private|group):\d{5,12}$/;

/** True for an empty target (owner in private) or a well-formed address. */
export function isSpeakTarget(value: string): boolean {
  return value === '' || SPEAK_TARGET_PATTERN.test(value);
}

export function malformedTargetMessage(value: string): string {
  return `target must look like group:<qq> or private:<qq>, got: ${value}`;
}
