/**
 * 待发的话（outbox）。
 *
 * 发言守卫会拒两类情形：那个聊天正等着她回话，或她刚在同一处说过。拒了不
 * 等于那句话没价值，所以给她一个**显式**出口：`when_free` 时先排队，等目标
 * 空下来再投。默认仍是立即发——排队是她自己的选择，不该把每句碎念都变成
 * 到点乱发的延时炸弹。
 *
 * 队列只活在账本会话的状态里，条目自带过期时间：过了 `expiresAt` 一律作废，
 * 因为一句针对十分钟前对话的回应，晚发出去比不发更糟。
 */

export type OutboxStatus = 'pending' | 'sent' | 'expired' | 'failed';

export interface OutboxItem {
  id: string;
  /** `''` 表示主人私聊，其余形如 `group:<qq>` / `private:<qq>`。 */
  target: string;
  text: string;
  createdAt: number;
  expiresAt: number;
  status: OutboxStatus;
  /** 投递结果或作废原因，一行就够。 */
  note?: string;
}

export const MAX_OUTBOX = 20;
export const MAX_OUTBOX_TEXT = 2000;

/** 只把发送/作废的旧条目丢掉，待发的永远留着。 */
export function trimOutbox(items: readonly OutboxItem[], max = MAX_OUTBOX): OutboxItem[] {
  if (items.length <= max) return [...items];
  const pending = items.filter((item) => item.status === 'pending');
  const settled = items.filter((item) => item.status !== 'pending');
  const keepSettled = Math.max(0, max - pending.length);
  return [...settled.slice(-keepSettled), ...pending].sort((a, b) => a.createdAt - b.createdAt);
}

export function enqueueOutbox(
  items: readonly OutboxItem[],
  input: { id: string; target: string; text: string; now: number; ttlMs: number },
): OutboxItem[] {
  const text = input.text.slice(0, MAX_OUTBOX_TEXT);
  const item: OutboxItem = {
    id: input.id,
    target: input.target,
    text,
    createdAt: input.now,
    expiresAt: input.now + Math.max(0, input.ttlMs),
    status: 'pending',
  };
  return trimOutbox([...items, item]);
}

/** 到点还没发出去的，标记过期（不改已发送/已失败的）。 */
export function sweepExpired(items: readonly OutboxItem[], now: number): OutboxItem[] {
  return items.map((item) =>
    item.status === 'pending' && now >= item.expiresAt
      ? { ...item, status: 'expired' as const, note: 'expired before the chat went quiet' }
      : item,
  );
}

export function pendingItems(items: readonly OutboxItem[]): OutboxItem[] {
  return items.filter((item) => item.status === 'pending');
}

export function markOutbox(
  items: readonly OutboxItem[],
  id: string,
  status: OutboxStatus,
  note?: string,
): OutboxItem[] {
  return items.map((item) => (item.id === id ? { ...item, status, note: note ?? item.note } : item));
}
