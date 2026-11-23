逐级读取上一级提示词至最高层为止。

# dsh-plugin-autonomy · 项目约定

## 命令

```bash
pnpm build         # tsc -p tsconfig.build.json，产物 lib/（仅 host 与 index）
pnpm build:client  # node scripts/build-client.mjs，产物 lib/client.js
pnpm test          # tsc -p tsconfig.json（含 client 与 test）+ node --test dist/test/*.test.js
```

改完 host 代码要重新 `build` **并重启宿主**才能生效；改 client 代码只需 `build:client`，**打开页面时 loader 重跑 bundle，不用重启**（2026-11-19 实测：字号控件构建完就能在线上看到，而同时构建的 `speakCooldownMinutes` 在活着的接口里查不到）。

`pnpm test` 先 `tsc` 到 `dist/` 再跑 `dist/test/*.test.js`：**删掉测试文件后老的 `dist/test/*.js` 还在，会假绿**。改了测试集合先 `rm -rf dist`。

## 目录职责

- `src/core/`：纯逻辑，不得 import 任何 `@deepseek-ai/*`。调度数学、意图状态机、run 生命周期都在这里，靠 `test/core.test.ts` 兜底。
- `src/host/`：宿主侧接线。`index.ts` 是入口（`name` / `inject` / `apply`），`scheduler.ts` 管节律，`wake.ts` 管唤醒与等待，`panel.ts` 管 HTTP 路由。
- `src/client/`：设置页卡片，经 `settings.section` 插槽注册；不参与 host 构建。
- `scripts/build-client.mjs`：客户端打包，负责外套 `window.__ModuleLoader__.load` 包装。
- `scripts/sync-diary-wishes.mjs`：把日记（aurabot `local-diary`）里的愿望同步进**愿望栏**（`wishes.json`，与台账并列、不是待办，带 `day` 与原文路径）；走面板 `intent-create` 接口，不直接改 `state.json`。`--url` / `--session` / `--diary` 三项必填（无默认路径，跑在谁家机器上都一样），定时在 crontab，日志 `/var/log/diary-wishes.log`。

## 硬约束（踩过）
- `GET /api/dsh-autonomy/state` 的 `sessions` 是**数组**，`openIntents`/`settledIntents` 在每一行里；读顶层同名键恒为空（2026-11-23 同步脚本据此去重失效，同一批愿望被导入两次，后来按 abandoned 收尾）。

1. **客户端 bundle id 必须等于包名**。`__ModuleLoader__.load({ id })` 里的 id 与 `dsh.client` 声明不一致时，loader 会认为 bundle 没注册、再执行一次，页面报 `duplicate factory registration`，卡片不出现。
2. **React 必须走 loader 注入**。客户端代码写 `import * as ReactNS from 'react'`（esbuild external 会编译成 factory 里的 `require("react")`），不要用 `ctx.get('react')`，那是 undefined。
3. **`exports["."]` 指向 `lib/index.js`**。`tsc -p tsconfig.build.json` 的 rootDir 是 `src`，入口在 `src/index.ts`（转发 `host/index.js`），别直接指向 `lib/host/index.js`。
4. **结算不能覆盖她的裁决**。`autonomy_finish` 写下的 decision 是她自己的交代，日志推断只能兜底：`if (current.status === 'completed') return;`。配套两处缺一不可：`canFinish()` 必须放行 `settling`（投递成功那一刻 run 就进 settling，她的收尾永远落在它之后，只认 `running` 会 100% 被拒）；观察器不能把 `autonomy_finish` 这次工具调用算成「做了事」。
5. **观察器认的事件名是本机宿主的**：助手发言是 `assistant/message`（不是 `message/inserted`），`time` 是毫秒数（不是 ISO 字符串）。两处都写错过一次，后果是「她说了什么」永远读不到、`minIdleMinutes` 静默失效。
6. **冷会话按 `sessionController.resolveAgent` 恢复**，别裸调 `agents.resume({resumeSessionId})`：后者不带预设与模型，`agent.options.model` 为空，人设段的 `{{model}}` 拼不出来，整轮直接 `prompt variable "{{model}}" has no value`（2026-11-19 实测）。控制器不在的宿主再退回裸 resume。
7. **面板要遍历全部已记录会话**，不只是当前 live 的：`StateStore.sessionIds()` 保证冷会话的历史仍然可见。`todayRuns` 是它们的合并时间线，按配置时区切「今天」，别用 `Date` 的本地日界。
8. **唤醒落点与聊天会话分开**。`config.wakeSession` 非空时 `managedSessions()` 只返回它，掷骰、记账、台账全部落在这一个会话（面板「建一个她的会话」用 `sessionController.create({})` 现造）。原因是 dsh-aurabot-qq 的群闸会在「这一轮不是主人」时把本机工具收走并黏住 live agent，唤醒落进群会话就只剩白名单工具（2026-11-19 实测 bash 直接 unknown tool）。
9. **说话走 `aurabot` 服务，不走工具闸**。`autonomy_say` 内部 `ctx.get('aurabot').send({target, text})`。这条路径不是 `tools.restrict` 管的范围，所以群会话里被收走 qq 工具时它照样能发；试运行、总开关仍由 dsh-aurabot-qq 的 `canSend` 判定。
10. **说话是三道闸，顺序不能换**：①主人私聊恒放行（不写 `target` 就是发主人，不需要配置）；②`config.speakTargets` 只加「除主人之外」的去处，空 = 除主人外一律不发，拒绝话术里要写明主人私聊仍可用；③插队守卫：那个聊天有人说了话她还没回 → 拒；同一聊天冷却期内（`speakCooldownMinutes`，默认 3，0=关）说过 → 拒。守卫全部从 `aurabot.events()` 的事件环重算，不另存状态；读不到事件环就退化成只查名单，不能因此把发言全堵死。
11. **唤醒永不抛异常**。宿主是 fail-loud（未捕获异常直接 exit(1)），而 `sessionController.resolveAgent` 可能返回 `{error}`；早期 `pickAgent` 把它当 agent、读 `.session.seq` 就把整个宿主带走了（2026-11-19 一次真实唤醒）。`looksLikeAgent` 必须验 `followup` 是函数、`session.seq` 是数字；`wake()` 外层 catch 成 `{status:'error'}`，调度侧再兜一层。
12. **台账是跨会话的**。账本归 `config.wakeSession`（落点空时归工具所在会话），`autonomy_intents` 读写要合并「本会话 + 落点会话」，`revise/complete/abandon` 必须先找到真正持有该 id 的会话再改；面板行要带 `ownerSessionId`，否则在唤醒房间点「完成」会报 `no intent <id>`。
13. **复盘不碰唤醒节奏**。攒够 `reviewBatch` 条判断（默认 5）、且距上次至少 `reviewMinGapMinutes`（默认 120）分钟，调度器才跑一次；它不改任何会话的 `nextCheckAt`、不占聊天会话，那一轮走 `aurabot.hub.runSystemTurn('autonomy-review', …, { noTools: true, key: 'review' })`，没装 dsh-aurabot-qq 就退回 `templateReview` 的确定性模板。产出追加到 `<dataDir>/journal/<date>.md`，`memoryDrafts` 经 `aurabot.call({module:'memory', method:'addEvent'})` 落记忆。token 预算按 2 字符≈1 token 粗估，超了从最旧的记录开始裁（`buildReviewPrompt`）。
14. **打分是纯函数，可复算**。`src/core/score.ts` 只看 `dueAt/preferredAt/kind/source` 与传入的 `recent` 文本，权重 `SCORE_WEIGHTS` 固定；`scoreEnabled` 只决定是否把候选塞进 framing，不改变台账状态（低分的意图仍然开着）。

## 与 aurabot 的边界

群会话能拿到哪些工具，由 dsh-aurabot-qq 的 `groupGates` 决定：`applyGroupGate` 定义在 `chat/hub.js:225`，挂载群会话时先收起（`:1244`），之后**只在每条 QQ 消息进来时**按发送者重算一次（`:3348` 调 `turnSendersAllTools`，判据是主人 / 无发送者且 `group.timerAsOwner` / 每个发送者都在 `capabilityAllow.tools` 里）。DSH 的 `tools.restrict` 是**取交集**、没有反向解锁的 API，插件侧只能收紧，放不开别人收的闸。

**说话要用它的服务，不是它的工具。** dsh-aurabot-qq 的 `bridge.dshTools` 关着时 `aurabot_qq_send` 不注册；插件侧要用就用 `ctx.get('aurabot').send`（源码注释里就这么建议）。`autonomy_say` 就是这么接的。

**不要改 dsh-aurabot-qq 的代码。** 2026-11-19 我把它当成本需求（唤醒按主人回合给权限）的落点，往安装副本的 `hub.js` 打了热补丁，被用户当场制止并要求撤回——已按备份还原、字节一致。

那条需求后来的结论不是「落地了」，也不是「还欠着」：**它被落点分离绕开了**。唤醒现在只落在她自己的会话（`wakeSession`），不进群会话，`groupGates` 根本不参与。群里的闸对插件注入的回合仍然不重算——注入那条路不经过 `:3348`，只会继承上一轮 QQ 消息留下的锁（2026-11-19 15:28 那次 `bash` 报 unknown 就是这个机制）。dsh-aurabot-qq 侧后来补的 `group.timerAsOwner`（默认 false，本机已开）只覆盖「无发送者的轮次」，`capabilityAllow.tools` 只覆盖「被授权的成员」，两者都不解决注入轮。要回群聊里唤醒，先解决这一条。

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

## 重启与部署

`/root/DSH/bin/dsh-restart-safe` 是唯一手段（禁止绕 systemctl）。它现在除了会话文件 90 秒内被写、回合未收尾（900 秒）之外，还读 `/root/.dsh/autonomy/state.json` 检查**在飞判断**（`queued`/`running`/`settling`，窗口 `SAFE_AUTONOMY_WINDOW` 默认 300 秒），命中就拒绝——否则重启会把那一轮记成 `interrupted · host restarted while this judgement was in flight`。

- 以「别人的会话文件刚被写过」拒绝时，等几十秒重跑即可，不要拿去问人；以「她正在回话（回合未收尾）」拒绝时，那是真在说话，等这轮结束。
- `state.json` 由 `StateStore.flush()` 整体重写，宿主运行中手改会被内存态覆盖：改完立刻重启。
- 脚本末尾打印的 token 常是上一次的（宿主启动约 14 秒后才写新的），要登录从 `/var/log/dsh-web.log` 末尾取。

## 交付前自检

- `rm -rf dist` 后再 `pnpm test`：`tsc` 不会删掉 `dist/test/` 里已删源文件留下的旧 `.test.js`，不清理会假绿（2026-11-19 删掉 quiet 模块后仍是 56/56，清完才是 49）。
- `pnpm build && pnpm build:client && pnpm test` 三件套全绿。
- 面板改动必须真实渲染并截图核对，接口返回 200 不代表卡片出现了。
- 端到端唤醒要看会话日志：注入事件应为 `source.kind = plugin:dsh-autonomy`，且标记行以 `[dsh-autonomy wake ` 开头；同时确认 `autonomy_finish` 落账（`tool/call` 的 arguments 里 run_id/decision/reason）与会话里真有本机工具（`bash` 之类）可用。
- 冷会话会话文件在 `/root/.dsh/sessions/--root--/<session-id>/session.v4.jsonl.zstd`，`zstd -dc` 后逐行 `json.loads`，按 `seq` 切 turn。

## 两条容易重犯的坑

**台账的读必须与唤醒提示同源。** 唤醒提示由调度器**跨全部会话**聚合未收尾意图，那么 `autonomy_intents list` 也必须扫全部会话（`wakeSession` 优先、其余按 `state.sessionIds()`），并逐条标出账本归属。2026-11-20 它只读「调用会话 + 唤醒房间」，于是她在房间里被告知「三条待办」、工具里只看见一条，把另外两条当成历史结论，连续两轮判 `no_action`。改动见 `d17c063`，契约测试 `test/ledger.test.ts`。

**客户端是 flex 列布局，列表会被静默裁行。** `.da-page`/`.da-body` 是 `display:flex; flex-direction:column`，列表作为 flex 子项默认 `flex-shrink:1`，空间不够时被压到剩余高度再 `overflow:hidden` 裁掉，分页器仍显示「共 16 条 · 第 1/1 页」——看着像只取了 5 条，其实是布局。`.da-body>*{flex-shrink:0;}` 与 `.da-list{flex:none;}` 已在 `src/client/shared.ts` 里钉住，新版块别再把这两条规则删掉。
