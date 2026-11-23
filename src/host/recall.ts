import { formatRecall, type RecallSource } from '../core/recall.js';

/**
 * 记忆库的只读客户端。
 *
 * 两种可取之处，选哪种由 `recallSource` 决定：
 * - `http`：任何兼容 `POST /api/recall` 的服务（MemoryConstellations 是其中一种）；
 * - `aurabot`：直接调 dsh-aurabot-qq 的 memory 模块 `recallAsync`，不必知道库在哪。
 * 两种都只读；失败一律返回空串（这轮就当没有记忆），但失败会记一条 warn。
 */

export interface RecallDeps {
  /** 这一轮从哪儿取：off / http / aurabot。 */
  source: () => RecallSource;
  /** aurabot 服务（`ctx.get('aurabot')`），只有 aurabot 源用得上。 */
  aurabot?: () => { call?: (input: { module: string; method: string; args?: unknown[] }) => Promise<unknown> } | undefined;
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
    const source = this.#deps.source();
    if (source === 'off') return '';
    if (source === 'aurabot') return await this.#recallFromAurabot(trimmed);
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
  /** 走 dsh-aurabot-qq 的 memory 模块：它自己排序，我们只负责把命中拼成几行。 */
  async #recallFromAurabot(query: string): Promise<string> {
    const bridge = this.#deps.aurabot?.();
    if (bridge === undefined || typeof bridge.call !== 'function') return '';
    try {
      const payload = await bridge.call({
        module: 'memory',
        method: 'recallAsync',
        args: [query, { limit: Math.min(Math.max(this.#deps.limit(), 1), 8) }],
      });
      const hits = (payload as { result?: unknown } | undefined)?.result;
      if (!Array.isArray(hits)) return '';
      const lines: string[] = [];
      for (const hit of hits) {
        const text = String((hit as { it?: { text?: unknown } })?.it?.text ?? '').trim();
        if (text !== '') lines.push(`- ${text}`);
        if (lines.length >= 6) break;
      }
      const joined = lines.join('\n');
      const cap = this.#deps.maxChars();
      return joined.length > cap ? `${joined.slice(0, cap)}…` : joined;
    } catch (error) {
      this.#deps.log?.warn(`memory recall via dsh-aurabot-qq failed: ${error instanceof Error ? error.message : String(error)}`);
      return '';
    }
  }

}
