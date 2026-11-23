# dsh-plugin-autonomy

DSH 大肥鱼自主意识插件：外部节律 + 概率掷骰唤醒，她自行决定行动还是沉默，带意图台账、判断记录与面板，可选对接 dsh-aurabot-qq 部分模块。

自主意识插件：**宿主按节律掷骰决定要不要唤醒，醒来后由她自己决定行动还是沉默。**

这不是"让她给自己排闹钟"。节律权在插件手里——外部间隔、概率、睡眠时段、每日额度都由宿主侧计时器掌管；她既不预约下一次，也不知道下一次什么时候来。被唤醒的那一轮，她拿到的是一段标注为非用户来源的自检提示，她可以说话、可以做事、也可以什么都不做，并用自己的话交代理由。

## 与 dsh-proactive 的区别

| | dsh-proactive | 本插件 |
| --- | --- | --- |
| 谁决定何时醒 | 她自己排闹钟（once/every/cron/file） | 宿主按平均间隔 + 抖动掷骰 |
| 概率 | 排了就一定触发 | 每次按 `probability` 掷，可 `adaptive` 随距上次活动变化 |
| 睡眠时段 | quiet hours 抑制投递 | 睡眠窗口内不掷骰（自排唤醒可豁免） |
| 意图台账 | 无 | 想法 / 约定两类，带版本与状态机 |
| 判断记录 | 每次投递一条 run | 每次掷骰命中一条 run，记 trigger / decision / reason / 起止时间 |

节律语义对齐 `whalelife-plugin-autonomy`：掷骰、概率、自适应倍率、睡眠窗口（含跨夜与跨周）、意图台账、判断记录、面板手动触发，这些行为一一对应；上游的 `allowSelfWake`、`timezone`、`motivation`、`requestId` 幂等、九态判断记录与「重启不重放」恢复语义也已搬过来。差异是本插件跑在 DSH 的宿主侧，用 `agents` 服务唤醒任意受管会话（冷会话会先恢复），而不是借助渠道插件的定时任务。

## 为什么不做成 dsh-aurabot-qq 下的模块

因为两者的「宿主」不是同一个东西。

- **落点不同**：本插件唤醒的是任意受管会话——她自己那间房、私聊、群会话都行——只依赖 DSH 的 `agents` 与 `tools` 两个服务。dsh-aurabot-qq 的节拍是挂在 QQ 网关、群闸、出站治理上的：做成它的模块，这套调度就得跟着那些东西一起启停。
- **依赖是单向且可选的**：本插件对 dsh-aurabot-qq 只有一处借用——`autonomy_say` 走它的出站通道（另外可选借它一条系统回合跑复盘）。没装 dsh-aurabot-qq 时这两样降级，其余照跑；反过来 dsh-aurabot-qq 不需要本插件。
- **维护成本**：dsh-aurabot-qq 是第三方仓库的 fork（上游 `aureth-labs/dsh-aurabot-qq`）。把一个通用插件塞进去，只会加深 fork 与上游的漂移，以后同步冲突一多，两边都不好改。

所以分工是：**调度、台账、判断记录、面板留在这边；说话的治理留给 dsh-aurabot-qq**。想把自主意识装到一台没有 dsh-aurabot-qq 的宿主上，直接装即可。

## 可选依赖

核心功能（节律、掷骰、台账、判断记录、面板、独立会话唤醒）只依赖 DSH 宿主本身，不装别的插件也能跑。下面两样可选，缺了只少对应能力：

- **dsh-aurabot-qq**：给 `autonomy_say` 提供出站通道（发 QQ 私聊或群），复盘那一轮也借它的系统回合。没有它时 `autonomy_say` 直接回「dsh-aurabot-qq is not available in this host, so nothing can be sent」，复盘退回确定性模板。
- **MemoryConstellations（`/api/recall`）**：醒来前按台账关键词查一段记忆拼进提示词。默认关闭，填了地址才查；查不到就当这轮没有记忆。

## 安装

```bash
dsh plugin add <本仓库路径或包名>
```

插件以 `cordis.patch.yml` 声明 bundle，宿主热加载即可生效，无需重启。

## 配置

配置落在 `<DSH_HOME>/autonomy/config.json`，面板可改，也可直接编辑后刷新。

**节律**

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后不再掷骰，手动触发仍可用 |
| `intervalMinutes` | `30` | 平均多久掷一次骰 |
| `jitterRatio` | `0.1` | 抖动比例，实际等待 = 间隔 ×(1 ± 抖动)。设 `0.5` 即上游「50%～150%」语义 |
| `probability` | `0.2` | 每次掷骰唤醒的概率 |
| `mode` | `fixed` | `fixed` 用原概率；`adaptive` 按距上次活动调整 |
| `adaptive.recentMinutes` / `recentMultiplier` | `20` / `0.15` | 距上次活动小于此值视为「刚聊过」 |
| `adaptive.distantMinutes` / `distantMultiplier` | `360` / `1.5` | 距上次活动超过此值视为「冷落已久」 |
| `sleepWindows` | `[]` | 如 `["23:00-08:00"]`；支持跨夜、多段，以及 `"23:00-08:00@5-1"` 这种「周五 23:00 → 周一 08:00」的跨周窗口（0=周日…6=周六） |
| `timezone` | `""` | 判断用的时区；留空用宿主时区 |
| `allowSelfWake` | `true` | 是否允许她用 `autonomy_schedule` 给自己排唤醒 |
| `selfWakeDuringSleep` | `false` | 她自排的唤醒是否允许落在睡眠窗口 |
| `maxRunsPerDay` | `20` | 每日判断次数上限，`0` 不限 |
| `minIdleMinutes` | `0` | 距上次活动不足此值则不掷骰 |
| `sessions` | `[]` | 目标会话；留空则管理全部根会话 |
| `maxRuns` / `maxIntents` | `20` / `50` | 每个会话保留的记录条数 |

**唤醒落点与说话**

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `wakeSession` | `""` | 唤醒落点；非空时只在这一个会话里掷骰、记账、记台账 |
| `wakeWorkspace` / `wakeTitle` | `""` | 面板「建一个她的会话」时用的工作区与标题 |
| `speakTargets` | `[]` | 除主人私聊之外允许说话的去处（`group:<群号>`）；空 = 只发主人 |
| `speakCooldownMinutes` | `3` | 同一个聊天两次发言的最短间隔，`0` 关掉冷却 |
| `outboxTtlMinutes` | `10` | 排队等对方安静的发言最多存多久，`0` = 只拒绝不排队 |

**判断与提示**

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `scoreEnabled` | `true` | 醒来前给台账打分排序，决定把哪几条摆到眼前 |
| `scoreThreshold` | `0.5` | 低于这个分数的条目不上提示（台账里仍然开着） |
| `moodEnabled` | `true` | 读她的心情调制这一轮摆什么（只动阈值与条数，不动节奏） |
| `recallSource` | `off` | 记忆召回从哪儿取：`off` / `http` / `aurabot` |
| `recallUrl` | `""` | `http` 源用的地址，兼容 `POST /api/recall`（MC 是其中一种） |
| `recallLimit` / `recallTimeoutMs` / `recallMaxChars` | `4` / `1200` / `600` | 召回条数、超时、塞进提示的最大字数 |
| `motivation` | `""` | 覆盖自主回合开场那段「决定做什么」的文案；留空用内置 |

**复盘**

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `reviewEnabled` | `true` | 攒够判断就让她复盘一次 |
| `reviewBatch` / `reviewMinGapMinutes` | `5` / `120` | 攒够几条、距上次多久才跑 |
| `reviewMaxInputTokens` / `reviewMaxOutputTokens` | `4096` / `512` | 复盘的 token 预算，超了从最旧的一条开始裁 |
| `reviewWriteMemory` | `false` | 复盘产出的记忆草稿是否写回 dsh-aurabot-qq 的 memory 模块 |

## 测试

```bash
rm -rf dist && pnpm test   # 118 个用例
```

- `test/core.test.ts`：间隔抖动、概率（fixed/adaptive）、睡眠窗口（跨夜/跨周/坏配置）、意图状态机、判断记录状态机。
- `test/score.test.ts` / `test/chill.test.ts` / `test/mood.test.ts`：打分各分项与排序、冷度与暂停、心情调制（阈值与条数、读不到就当没有）。
- `test/recall.test.ts` / `test/wish.test.ts`：三种召回源与旧配置迁移、愿望去重与划掉。
- `test/review.test.ts` / `test/reviewer.test.ts`：复盘的触发条件、落盘与模板兜底。
- `test/contracts.test.ts`：`quiet-contract`、`queue-contract`、`daily-budget`、`recovery-contract`、`settling`、`cancel-contract`、`wake-room`、`speak-contract`、`wish-contract`、`ledger-*`。

## 工具

她会话里可以调用五个工具：

- `autonomy_schedule`：`get` 看待机状态，`set` 指定 `at`（`YYYY-MM-DDTHH:MM`）或 `in_minutes` 排一次自排唤醒，`cancel` 撤销。`set`/`cancel` 都支持 `version`（陈旧版本拒覆盖）与 `requestId`（同一 id 重复提交不重排）。`allowSelfWake=false` 时 `set`/`cancel` 一律拒绝。
- `autonomy_intents`：`list` 看未完成意图，`remember` 记一条（`kind=agreement` 必须给 `due_at`），`revise` 改，`complete` / `abandon` 收尾（都要带 `version` 防覆盖）。
- `autonomy_wishes`：`list` 看日记里的愿望（带日期与原文路径），`drop` 划掉一条。
- `autonomy_say`：`{ target, text }` 把一句话发出去。`target` 留空 = 发主人私聊，`group:<群号>` 自己挑；发不出去时可用 `when_free` 排队，并声明 `why`。
- `autonomy_finish`：结束当前自主轮，`decision` 取 `acted` 或 `no_action`，`reason` 一句话。只对进行中的 run 有效；不调用也能收尾，此时按事件日志推断。

## 面板

设置 → Autonomy 里只有一行状态和「打开面板」，真正的界面在独立页面（`/dsh-autonomy`）：

- **概览**：今天的判断数、未完成意图、下一次掷骰、唤醒落点；今天的判断流水。
- **判断记录**：跨会话的全部判断，可按触发方式、结果、会话筛选，也能按理由里的字搜；分页。
- **意图台账**：想法与约定，带到期、冷度与暂停状态。
- **愿望**：日记里许的愿，带日期与原文路径，可手动补记或划掉。
- **排程**：下一次掷骰、自排唤醒、手动「现在判断一次」。
- **配置**：上面那些键，保存即写盘。

面板走 `/api/dsh-autonomy/{state,action,events,runs}`，前端通过 SSE 自动刷新。

## 心情

她的心情读自 dsh-aurabot-qq 的心情模块（`ctx.get('aurabot').use('mood').state()`），**只影响这一轮把什么摆到眼前**：低于 40 分时打分门槛 +0.1、候选上限压到 2；高于 75 分时门槛 −0.05；中间档原样。掷骰、间隔、睡眠窗、每日预算一律不动。没装该插件、或它没开心情模块，就直接跳过这一档。每轮读到的心情会写进判断记录（形如 `mood 60/100 平平常常`）。

## 打分与候选

醒来前把全库未完成的意图汇总，按一个纯函数打分排序：`0.4×紧迫 + 0.3×新鲜 + 0.2×来源 + 0.1×承诺`。紧迫看 `dueAt`／`preferredAt` 与现在的距离；新鲜是与最近几条已收尾意图、最近几条判断理由的文本重合度；来源分主人／对话／自己；承诺看是约定、自排还是念头。过了门槛（`scoreThreshold`）的前三条进提示，其余仍开着，只是这一轮不摆。

连续几轮被摆到眼前却始终没动的条目会累积冷度（每漏一次 +0.5），到 2 就暂停 7 天；她真动手（`acted`）就清零。

## 复盘

攒够 `reviewBatch` 条判断、且距上次至少 `reviewMinGapMinutes` 分钟，调度器在空闲时段跑一次复盘：把这段时间的判断与意图整理成一页日刊，追加到 `<dataDir>/journal/<date>.md`。这一轮借 dsh-aurabot-qq 的系统回合（`noTools: true`），没装它就退回确定性模板。它不改任何会话的唤醒时间。

## 记忆召回

醒来前可以拿台账当关键词去查一段旧事，塞进提示词。三种源：

- `off`：不查；
- `http`：`POST` 到 `recallUrl`，任何兼容 `/api/recall` 的服务都行（MemoryConstellations 是其中一种）；
- `aurabot`：直接问 dsh-aurabot-qq 的 memory 模块（`recallAsync`），不用填地址。

查不到就当这轮没有记忆，不阻断唤醒；`off` 时连请求都不发。

## 说话与待发队列

`autonomy_say` 有三道闸：主人私聊恒放行；`speakTargets` 里的群才允许发；目标聊天里有人说了话她还没回、或同一个聊天还在冷却期，一律拒。拒了可以用 `when_free` 排队，等对方安静后由调度器每轮扫描时补发，超过 `outboxTtlMinutes` 作废。真正投递走 dsh-aurabot-qq 出站通道，它自己的名单、试运行与总开关仍然生效。

## 日记愿望接台账

日记模块（aurabot 的 `local-diary`）每天写完就没人管，许的愿躺在
`modules-data/local-diary/index.json` 的 `wishes` 里。`scripts/sync-diary-wishes.mjs`
把它们记进插件的**愿望栏**（`<dataDir>/wishes.json`）——和意图台账并列，但**不是待办**：
愿望可能很大、很久，也可能永远做不到，所以不给截止、不催收尾、不计入待办那条线。
每条都带着日记日期与原文路径，她想回看就照路径去读原文。

这个脚本对**没装 dsh-aurabot-qq 的人没有任何影响**：它不随插件加载，也没有任何脚本或钩子去调它，整份代码只 `import { readFileSync } from 'node:fs'`，三个位置全必填。换句话说，它只是一个「你要用 aurabot 的日记模块时，手动跑或挂 cron」的独立工具；没有日记索引文件，它连启动都过不去。

```bash
node scripts/sync-diary-wishes.mjs \
  --url http://127.0.0.1:3301 \
  --session session-xxxxxxxx-.... \
  --diary /path/to/aurabot/modules-data/local-diary/index.json \
  [--dry-run] [--days N]
```

三个位置都必须显式给（脚本不带任何默认路径）：`--session` 填配置里的 `wakeSession`，`--url` 是面板地址，`--diary` 是日记索引文件。也可以改用环境变量 `AUTONOMY_URL` / `AUTONOMY_SESSION_ID` / `DIARY_INDEX`，参数优先。

- 去重：归一化（全角转半角、去空白与标点）后一方包含另一方即算同一件事，开着的和已收尾的台账都参与比对。
- 写入走面板接口 `POST /api/dsh-autonomy/action?session=<wakeSession>`，body `{type:'intent-create', text, kind:'thought'}`——不直接改 `state.json`，免得被宿主内存态覆盖。
- 定时示例（crontab，参数照上面那三样写全）：`45 23 * * * AUTONOMY_URL=http://127.0.0.1:3301 /usr/bin/node <repo>/scripts/sync-diary-wishes.mjs --session <wakeSession> --diary <index.json> >> /var/log/diary-wishes.log 2>&1`。

## 数据

```
<DSH_HOME>/autonomy/
├── config.json   配置
└── state.json    每会话：lastActivityAt / nextCheckAt / selfWake / intents / runs
```

写入走临时文件 + rename，崩溃不会截断。

## 开发

```bash
pnpm install
pnpm build        # host 侧 tsc → lib/
pnpm build:client # 客户端 esbuild → lib/client.js
pnpm test         # 111 个用例，覆盖抖动、概率、跨夜与跨周窗口、意图状态机、run 生命周期、宿主契约
```

`src/core/` 是纯逻辑，不依赖任何 `@deepseek-ai` 包，可单独测试。

要动手改它，先看 [CONTRIBUTING.md](./CONTRIBUTING.md)：目录职责、改完怎么验、`dist` 那个假绿的坑、提交约定都在那儿。

## 已知边界

- 冷会话优先走宿主的 `sessionController.resolveAgent` 恢复（带预设与模型），控制器不在的宿主才退回 `agents.resume`；恢复失败时该次计入 `failed` 并留下错误文本。
- `minIdleMinutes` 依赖宿主写入的活动时间；长时间空闲的会话会按自适应倍率提高概率。
- 面板展示的是最近 20 条判断、50 条意图（可在配置里调整保留条数）。

## 许可证

MIT，见 [LICENSE](./LICENSE)。

## 致谢

外部节律掷骰、意图台账、判断记录与面板的设计出自[iinukami/whalelife-plugin-autonomy](https://github.com/iinukami/whalelife-plugin-autonomy)，配置项与工具命名也沿用其约定。本仓库是在DSH插件API上的独立实现，未复制其源码。

「说出去」这一步没有自己造轮子：`autonomy_say` 经 dsh-aurabot-qq（[aureth-labs/dsh-aurabot-qq](https://github.com/aureth-labs/dsh-aurabot-qq)）暴露的 `aurabot` 服务出站，名单与插队判定在本插件里做，投递与它自己的规则仍归 dsh-aurabot-qq。复盘、冷度与记忆召回同样是照着 dsh-aurabot-qq 自驱（v5 五环）与 [aurabot-mod-mc-recall](https://github.com/devil233-ui/aurabot-mod-mc-recall) 的思路做的：事前一刀、分由结果挣、久无回应的条目自动降温。思路参照，未复制其源码。
