/**
 * 愿望：她在日记里许下、但**不是待办**的那些事。
 *
 * 和意图台账并列而不是混在一起，因为两者性质不同：意图是「我答应要做的」，
 * 有状态机、有截止、要收尾；愿望只是「我想过」，可能很大、很久，也可能永远
 * 做不到。混进台账会把待办变成一句空话，也会让她每天被同一批做不到的事压着。
 *
 * 每条愿望都记着来源（哪一天的日记、哪个文件），她可以照着路径回去读原文。
 */

export interface Wish {
  id: string;
  text: string;
  /** 日记的日期，`YYYY-MM-DD`。 */
  day: string;
  /** 日记原文所在文件（绝对路径），她可以据此反查。 */
  source: string;
  /** 记进这里的时间（ISO）。 */
  addedAt: string;
}

export const MAX_WISHES = 300;
export const MAX_WISH_TEXT = 500;

/** 去重用的键：忽略大小写、空白与常见标点。 */
export function wishKey(text: string): string {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[「」『』“”"'，,。.、；;：:！!？?（）()【】\[\]…—\-·]/g, '');
}

/** 归一化后一方包含另一方即视为同一条（短的那条至少 6 个字）。 */
export function sameWish(a: string, b: string): boolean {
  const x = wishKey(a);
  const y = wishKey(b);
  if (x === '' || y === '') return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 6 && long.includes(short);
}

export function trimWishText(text: string): string {
  const trimmed = String(text ?? '').trim();
  return trimmed.length <= MAX_WISH_TEXT ? trimmed : trimmed.slice(0, MAX_WISH_TEXT) + '…';
}

/** 超出上限时丢最旧的。 */
export function trimWishes(list: readonly Wish[], limit: number = MAX_WISHES): Wish[] {
  if (list.length <= limit) return [...list];
  return list.slice(list.length - limit);
}
