/**
 * 她的房间建在哪个工作区。
 *
 * `sessionController.create()` 只给 `{ workspaceId }` 或 `{ cwd }` 二选一，
 * 不传就落到宿主默认的 cwd（这台机器上是 `/root`）——那样房间会掉进「root」
 * 工作区、跟她的聊天会话（宿主默认工作区）分家，列表里还是一片未命名。
 *
 * 所以配置里那一栏允许用户写工作区 id 或绝对路径，由这里判形状：
 * 36 位 UUID 当 id 传，其余当 cwd 传。
 */
export const WAKE_ROOM_TITLE = '自主意识 · 她的房间';

/** 配置里没写标题时用内置那个。 */
export function wakeRoomTitle(raw: string): string {
  const value = raw.trim();
  return value === '' ? WAKE_ROOM_TITLE : value;
}

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WakeRoomRequest {
  readonly workspaceId?: string;
  readonly cwd?: string;
}

/** Turn the configured value into the create() argument. Empty means "host default". */
export function wakeRoomRequest(raw: string): WakeRoomRequest {
  const value = raw.trim();
  if (value === '') return {};
  if (WORKSPACE_ID.test(value)) return { workspaceId: value };
  return { cwd: value };
}

/** Read back what a create() request asked for, for logs and error messages. */
export function describeWakeRoom(request: WakeRoomRequest): string {
  if (request.workspaceId !== undefined) return `workspace ${request.workspaceId.slice(0, 8)}`;
  if (request.cwd !== undefined) return request.cwd;
  return 'the host default workspace';
}
