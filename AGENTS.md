逐级读取上一级提示词至最高层为止。

# dsh-plugin-autonomy · 项目约定

## 命令

```bash
pnpm build         # tsc -p tsconfig.build.json，产物 lib/（仅 host 与 index）
pnpm build:client  # node scripts/build-client.mjs，产物 lib/client.js
pnpm test          # tsc -p tsconfig.json（含 client 与 test）+ node --test dist/test/*.test.js
```

改完 host 代码要重新 `build` 并重启宿主才能生效；改 client 代码要重新 `build:client`，随后刷新页面（loader 会重新执行 bundle）。

## 目录职责

- `src/core/`：纯逻辑，不得 import 任何 `@deepseek-ai/*`。调度数学、意图状态机、run 生命周期都在这里，靠 `test/core.test.ts` 兜底。
- `src/host/`：宿主侧接线。`index.ts` 是入口（`name` / `inject` / `apply`），`scheduler.ts` 管节律，`wake.ts` 管唤醒与等待，`panel.ts` 管 HTTP 路由。
- `src/client/`：设置页卡片，经 `settings.section` 插槽注册；不参与 host 构建。
- `scripts/build-client.mjs`：客户端打包，负责外套 `window.__ModuleLoader__.load` 包装。

## 硬约束（踩过）

1. **客户端 bundle id 必须等于包名**。`__ModuleLoader__.load({ id })` 里的 id 与 `dsh.client` 声明不一致时，loader 会认为 bundle 没注册、再执行一次，页面报 `duplicate factory registration`，卡片不出现。
2. **React 必须走 loader 注入**。客户端代码写 `import * as ReactNS from 'react'`（esbuild external 会编译成 factory 里的 `require("react")`），不要用 `ctx.get('react')`，那是 undefined。
3. **`exports["."]` 指向 `lib/index.js`**。`tsc -p tsconfig.build.json` 的 rootDir 是 `src`，入口在 `src/index.ts`（转发 `host/index.js`），别直接指向 `lib/host/index.js`。
4. **结算不能覆盖模型裁决**。`autonomy_finish` 写下的 decision 是模型自己的交代，日志推断只能兜底：`if (current.status === 'completed') return;`。配套两处缺一不可：`canFinish()` 必须放行 `settling`（投递成功那一刻 run 就进 settling，模型的收尾永远落在它之后，只认 `running` 会 100% 被拒）；观察器不能把 `autonomy_finish` 这次工具调用算成「做了事」。
5. **观察器认的事件名是本机宿主的**：助手发言是 `assistant/message`（不是 `message/inserted`），`time` 是毫秒数（不是 ISO 字符串）。两处都写错过一次，后果是「她说了什么」永远读不到、`minIdleMinutes` 静默失效。
6. **冷会话按 `sessionController.resolveAgent` 恢复**，别裸调 `agents.resume({resumeSessionId})`：后者不带预设与模型，`agent.options.model` 为空，人设段的 `{{model}}` 拼不出来，整轮直接 `prompt variable "{{model}}" has no value`（2026-11-19 实测）。控制器不在的宿主再退回裸 resume。
7. **面板要遍历全部已记录会话**，不只是当前 live 的：`StateStore.sessionIds()` 保证冷会话的历史仍然可见。

## 与 aurabot 的接口（跨插件约束）

群里唤醒能拿到哪些工具，由 aura 的 `groupGates` 决定（`hub.js:141/147` 收紧、`:987` 挂载时先收起、`:2921` 每轮按说话人开合）。DSH 的 `tools.restrict` 是**取交集**、没有反向解锁的 API，所以「自主唤醒按主人回合给权限」只能在 aura 侧放开：`onSessionEvent` 见 `source.kind === 'plugin:dsh-autonomy'` 就 `applyGroupGate(key, true)`，`turn/end` 再按上一轮 QQ 说话人还回去。

那是打在安装副本 `profiles/web/node_modules/dsh-aurabot-qq/src/chat/hub.js` 上的**热补丁**，`dsh plugin add/update` 升级 aura 会覆盖；原件在 `/root/Backup/aurorabot-qk-gate-20261119-161245/hub.js.改前`。升级后先查日志里 `本机工具放开（这一轮是主人）` 这行还在不在。

## 隔离实例验证

宿主重启前先在独立 home 里跑一遍，避免污染生产 profile：

```bash
DSH_HOME=/tmp/iso dsh --profile iso --from-default-profile web --dump-config
DSH_HOME=/tmp/iso dsh plugin --profile iso add <本仓库绝对路径>   # 出 link: 说明，源目录不会被搬
# 模型凭据：把生产的 llm-pi-ai + agent-default-model 复制进 iso 的 cordis.patch.yml，
# 再按 apiKeyEnv 指定的变量名（下文以 API_KEY 代指）把 key 注入启动命令
DSH_HOME=/tmp/iso dsh --profile iso --port 8611 --no-open
```

面板 API 无 cookie 直连即可验证：`curl -s localhost:8611/api/dsh-autonomy/state`。

## 交付前自检

- `pnpm build && pnpm build:client && pnpm test` 三件套全绿。
- 面板改动必须真实渲染并截图核对，接口返回 200 不代表卡片出现了。
- 端到端唤醒要看会话日志：注入事件应为 `source.kind = plugin:dsh-autonomy`，且标记行以 `[dsh-autonomy wake ` 开头。
