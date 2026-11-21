import { readMood, type MoodReading } from '../core/mood.js';

/**
 * 读她此刻的心情。
 *
 * 走 aura 插件的服务面（同进程直接拿模块对象）：`use('mood').state()` 是纯读，
 * 不落盘、不发消息。读不到（没装 aura、模块没跑、接口变了）就当这轮没有心情，
 * 不阻断唤醒，也不拿默认值假装她心情不错。
 */

export interface MoodProbeDeps {
  /** 取 aura 的 `mood` 模块；拿不到返回 undefined。 */
  module: () => unknown;
  log?: { warn(message: string): void };
}

export class MoodProbe {
  readonly #deps: MoodProbeDeps;
  #warned = false;

  constructor(deps: MoodProbeDeps) {
    this.#deps = deps;
  }

  read(): MoodReading | undefined {
    try {
      const mod = this.#deps.module() as { state?: () => unknown } | undefined;
      if (mod === undefined || mod === null || typeof mod.state !== 'function') return undefined;
      return readMood(mod.state());
    } catch (error) {
      if (!this.#warned) {
        this.#warned = true;
        this.#deps.log?.warn(`mood read failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return undefined;
    }
  }
}
