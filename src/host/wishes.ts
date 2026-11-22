/**
 * 愿望的持久化。
 *
 * 单独一个文件（`<dataDir>/wishes.json`），不塞进按会话组织的 `state.json`：
 * 愿望是跨会话的事实，属于她而不是某一条聊天。写入走临时文件 + rename，
 * 崩溃不会留下半个 JSON。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { sameWish, trimWishes, trimWishText, type Wish } from '../core/wish.js';

export interface WishInput {
  text: string;
  day: string;
  source: string;
}

export interface WishStoreDeps {
  file: string;
  now: () => number;
  idFactory?: () => string;
  log?: { warn(message: string): void };
}

function newId(): string {
  return `w${Math.random().toString(16).slice(2, 10)}`;
}

export class WishStore {
  readonly #deps: WishStoreDeps;
  #items: Wish[];

  constructor(deps: WishStoreDeps) {
    this.#deps = deps;
    this.#items = this.#load();
  }

  list(): readonly Wish[] {
    return this.#items;
  }

  /** 重复的不再记：归一化后一方包含另一方即视为同一条。 */
  add(input: WishInput): { ok: true; wish: Wish } | { ok: false; reason: 'empty' | 'duplicate' } {
    const text = trimWishText(input.text);
    if (text === '') return { ok: false, reason: 'empty' };
    if (this.#items.some((wish) => sameWish(wish.text, text))) return { ok: false, reason: 'duplicate' };

    const wish: Wish = {
      id: (this.#deps.idFactory ?? newId)(),
      text,
      day: String(input.day ?? '').trim(),
      source: String(input.source ?? '').trim(),
      addedAt: new Date(this.#deps.now()).toISOString(),
    };
    this.#items = trimWishes([...this.#items, wish]);
    this.#flush();
    return { ok: true, wish };
  }

  drop(id: string): boolean {
    const next = this.#items.filter((wish) => wish.id !== id);
    if (next.length === this.#items.length) return false;
    this.#items = next;
    this.#flush();
    return true;
  }

  #load(): Wish[] {
    try {
      const raw = JSON.parse(readFileSync(this.#deps.file, 'utf8')) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.filter((row): row is Wish => {
        if (typeof row !== 'object' || row === null) return false;
        const item = row as Partial<Wish>;
        return typeof item.id === 'string' && typeof item.text === 'string';
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'ENOENT') this.#deps.log?.warn(`wishes.json 读取失败：${String(error)}`);
      // 文件不存在属于正常首次运行；把加载失败也当成空，避免插件起不来。
      return [];
    }
  }

  #flush(): void {
    try {
      mkdirSync(dirname(this.#deps.file), { recursive: true });
      const tmp = `${this.#deps.file}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(this.#items, null, 2)}\n`, 'utf8');
      renameSync(tmp, this.#deps.file);
    } catch (error) {
      this.#deps.log?.warn(`wishes.json 写盘失败：${String(error)}`);
    }
  }
}
