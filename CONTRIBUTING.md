# 参与这个插件

先读 [README](./README.md) 的「配置」「工具」「面板」三节，那里是行为约定；这份文件只讲怎么改它。

## 环境

- Node 22 以上，pnpm。
- 只需要 DSH 宿主本身即可开发；aura（`dsh-aurabot-qq`）与 MemoryConstellations 都是可选的，缺了只少对应能力。

```bash
pnpm install
pnpm build         # host 侧 tsc → lib/
pnpm build:client  # 客户端 esbuild → lib/client.js
pnpm test          # 全部用例
```

## 目录

| 目录 | 职责 |
|---|---|
| `src/core/` | 纯逻辑：节律、掷骰、意图状态机、打分、复盘模板。**不 import 任何 `@deepseek-ai/*`**，可以脱离宿主单测 |
| `src/host/` | 宿主侧接线：调度器、唤醒、观察器、工具注册、面板路由 |
| `src/client/` | 面板前端（React，走 `__ModuleLoader__` 加载） |
| `test/` | 与 `src/` 同构，`node --test` 跑 |

新增逻辑优先落在 `src/core/`：能单测的部分越多，改动越不容易把宿主拖下水。

## 改完怎么验

- **宿主侧改动（`src/host`、`src/index.ts`）**：需要重启宿主进程才生效。
- **客户端改动（`src/client`）**：重新 `pnpm build:client`，刷新页面即生效，不用重启。
- 改完至少跑一次 `pnpm build && pnpm build:client && pnpm test`。

**一个坑**：删掉或改名了某个 `.ts` 文件后，必须先 `rm -rf dist` 再跑 `pnpm test`。`tsc` 不清理输出目录，旧的 `dist/test/*.test.js` 会继续被执行，测试数看着全绿，其实测的是已经删掉的代码。

## 提交与 PR

- 一个 PR 解决一件明确的事，别把重构和新功能混在一起。
- 提交信息用中文，`gitmoji + scope: 主题`，正文写清楚**行为变化、原因、验证结果**。
- 界面改动请在描述里说明看过实际渲染；宿主侧改动附脱敏后的关键日志。
- 不要提交本地配置（`config.json`）、运行数据（`state.json`、`journal/`、`dreams/`）、日志与备份文件。

## 不要做的事

- 不要为了「让测试过」而修改断言语义——先确认被改的行为是不是真的该改。
- 不要在本仓库里直接改 aura 的安装副本；需要它配合的地方，走它自己的仓库提 PR。
- `src/core/` 里不要引入 IO：时间从参数传进来，随机数从参数传进来，这样同一状态同一时钟永远得同一结果。
