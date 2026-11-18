# DSH 0.2.1-rc.2 插件 API 勘察（本插件实际会用到的部分）

勘察对象：`/root/.nvm/versions/node/v24.11.1/lib/node_modules/@deepseek-ai/dsh`（CLI 0.2.1-rc.2）
参照实现：`/tmp/dsh-proactive-probe/packages/dsh-proactive`（同版本 peer 范围，v0.3.2）

## 1. 插件入口形态

```ts
export const name = "dsh-autonomy";
export const inject = ["agents", "tools", "webServer"]; // webServer 缺省可降级
export function apply(ctx: Context) { ... }
```

来源：`src/index.ts:26-28`（proactive 用 `inject = ["agents","tools","sessionPersistence","workspaceRegistry"]`）。
`webServer` 在本机 web profile 组合中存在；headless 时应降级为无面板、只留工具。

## 2. Agent 获取与唤醒

- 取活性句柄：`ctx.agents.get(sessionId) => Agent | undefined`
  来源 `src/wake.ts:391-397`。
- 根 agent 列表：`ctx.agents.roots()`，来源 `src/index.ts:195`（`if (!ctx.agents.roots().includes(agent)) return;`）。
- 冷恢复：`await ctx.agents.resume({ resumeSessionId, agentOptions, setup })` → 返回 `{ agent, dispose? }`
  来源 `src/wake.ts:395-398`，`handle.agent` 使用。
- 创建/恢复事件：`ctx.on("agent/created", ({ agent }) => ...)`，返回 disposer。
  来源 `src/index.ts:202`。
- 注入消息（必须走维护窗口）：
  ```ts
  const claimed = await agent.runMaintenance(() => { agent.followup(message); return Promise.resolve(true); });
  if (!claimed) { /* busy, 稍后重试 */ }
  await agent.whenIdle();
  ```
  来源 `src/wake.ts:433-445`。
- 回合起点：`agent.session.seq`（投递前记录），来源 `src/wake.ts:436`。
- 会话事件读取：`sessionLogOf(agent.session)` —— 优先 `session.events` 数组，否则 `session.snapshotEvents()`
  来源 `src/wake.ts:104-110`。

## 3. 消息来源标记（非用户来源）

v4 会话格式使用 producer-owned source kind：

```ts
createUserMessage({
  text,
  source: { kind: "plugin:dsh-autonomy", form: "notice", summary: "..." }
})
```

来源 `src/framing.ts:60-77`（`PROACTIVE_SOURCE_KIND = "plugin:" + PROACTIVE_PLUGIN`，form "notice"）。
v3 的 `{kind:"plugin", plugin}` 包装在 v4 写盘时会被拒（同文件注释 42-55），不要再用。
GUI 侧 notice 渲染为上下文芯片而非用户气泡。

## 4. 工具注册（每 agent 作用域）

```ts
agentCtx.tools.register(defineTool({ name, description, parameters, execute, presentCall }))
```

来源 `src/tools.ts:586-600`（`registerProactiveTools` 用 `agentCtx.effect(...)` 包住，逐个 register 并返回 disposer）。
`defineTool` 来自 `@deepseek-ai/dsh-tools`，参数 schema 用 `ParameterSchemaSpec` / `ValueSchemaSpec`。
工具在 agent 创建时挂、resume 时由 `agent/created` 补挂。

## 5. 面板（host 侧路由）

```ts
const web = ctx.get("webServer", false) as { register(route): () => void } | undefined;
web?.register({ kind: "exact", path: "/api/dsh-autonomy/state", handler });
```

来源 `src/panel/routes.ts:12-14`（WebServerLike）与路由表注释 1-8。
headless 无 webServer 时 no-op + 一行日志。

## 6. 面板（client 侧插槽）

```ts
export const inject = ["slots", "remote", "connection", "locale"];
ctx.slots.settings.section({ ... })  // 设置页卡片
```

来源 `src/client/index.ts:44`（inject）与 `src/client/index.tsx` 的 settings.section 挂载。
客户端 bundle 必须打成 `window.__ModuleLoader__.load({ id, factory })` 懒加载 CJS，外部依赖走共享 require
（`scripts/build-client.mjs:8-30`）。
`dsh.client.inject` 在 package.json 里声明需要的外壳包：connection / ui-settings / ui-renderer / ui-session / store。

## 7. 配置与热更新

- 配置命名空间：`ctx.settings` + schemastery（来源 `src/settings.ts:1-10`）。
- v1 采用更简单的路径：`<dataDir>/config.json` 手写读写（与 proactive 的 config.ts 等价），
  面板保存时整份落盘；不做 schemastery 命名空间，避免依赖外壳版本细节。

## 8. 数据目录约定

- proactive：`~/.dsh/proactive/{alarms.json,runs.jsonl,state.json}`（来源 `src/config.ts`）。
- 本插件：`~/.dsh/autonomy/{state.json,config.json,runs.jsonl}`，可用 `DSH_AUTONOMY_DATA` 覆盖。

## 9. 待实测项

- [ ] `ctx.agents.get()` 对「从未在当前宿主进程打开的会话」是否返回 undefined（预期是，需走 resume）。
- [ ] `runMaintenance` 在 agent 正忙时的拒绝形态（预期返回 false 或抛错）。
- [ ] 面板 client 插槽在 0.2.1-rc.2 的实际 props 形状（settings.section 的 owner props）。
- [ ] notice 来源消息在 GUI 的渲染（芯片/纯文本），决定 summary 文案。
