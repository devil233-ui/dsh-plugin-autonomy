import { formatRecall } from '../core/recall.js';

/**
 * 记忆库的只读客户端。
 *
 * 只做一件事：把一句话送去 MemoryConstellations 的 `/api/recall`，拿回它
 * 格式化好的那几段。写记忆不在这里——库那边现在是只读召回，写入要另一套
 * 鉴权，不去伸手。
 */

export interface RecallDeps {
  url: () => string;
  limit: () => number;
  timeoutMs: () => number;
  maxChars: () => number;
  log?: { warn(message: string): void };
  fetchImpl?: typeof fetch;
}

export class MemoryRecall {
  readonly #deps: RecallDeps;

  constructor(deps: RecallDeps) {
    this.#deps = deps;
  }

  /** 失败一律返回空串（这轮就当没有记忆），但失败本身不再被吞掉。 */
  async recall(query: string): Promise<string> {
    const trimmed = query.trim();
    if (trimmed === '') return '';
    const url = this.#deps.url().trim();
    if (url === '') return '';
    const fetchImpl = this.#deps.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(200, this.#deps.timeoutMs()));
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: trimmed, limit: Math.min(Math.max(this.#deps.limit(), 1), 20) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.#deps.log?.warn(`[autonomy] recall HTTP ${response.status} from ${url}`);
        return '';
      }
      const data = (await response.json().catch(() => null)) as unknown;
      return formatRecall(data, this.#deps.maxChars());
    } catch (error) {
      this.#deps.log?.warn(`[autonomy] recall failed (${error instanceof Error ? error.message : String(error)})`);
      return '';
    } finally {
      clearTimeout(timer);
    }
  }
}
