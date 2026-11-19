/**
 * 记忆库召回结果的整理（纯函数）。
 *
 * 记忆库是 MemoryConstellations 那套：`POST /api/recall` 收 `{query, limit}`，
 * 回 `{success, count, formatted}`。这里只管两件事：怎么判断「这次召回算数」，
 * 以及在塞进提示词之前把它裁到预算内。
 */

export interface RecallPayload {
  success?: unknown;
  count?: unknown;
  formatted?: unknown;
}

/** 召回失败、没命中、或内容为空都返回空串——空串等于「这轮没有记忆可看」。 */
export function formatRecall(data: unknown, maxChars: number): string {
  if (data === null || typeof data !== 'object') return '';
  const payload = data as RecallPayload;
  if (payload.success !== true) return '';
  if (!(Number(payload.count) > 0)) return '';
  const body = String(payload.formatted ?? '').trim();
  if (body === '') return '';
  return body.slice(0, Math.max(0, Math.trunc(maxChars)));
}

/**
 * 召回用的那句话。优先用这一轮排到眼前的候选，没有就退回台账里的头几条；
 * 两样都空就不召回——没有素材时拿一句空话去查库只会捞回一堆不相干的东西。
 */
export function recallQuery(input: {
  candidates?: readonly { text: string }[];
  openIntents?: readonly { text: string }[];
  note?: string;
  maxChars?: number;
}): string {
  const limit = Math.max(20, Math.trunc(input.maxChars ?? 240));
  const parts: string[] = [];
  const source = input.candidates !== undefined && input.candidates.length > 0 ? input.candidates : (input.openIntents ?? []);
  for (const item of source.slice(0, 3)) {
    const text = item.text.trim();
    if (text !== '') parts.push(text);
  }
  if (parts.length === 0 && input.note !== undefined && input.note.trim() !== '') parts.push(input.note.trim());
  return parts.join('；').slice(0, limit);
}
