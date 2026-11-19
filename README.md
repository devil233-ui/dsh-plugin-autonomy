# dsh-plugin-autonomy

自主意识插件：**宿主按节律掷骰决定要不要唤醒，醒来后由模型自己决定行动还是沉默。**

这不是"让模型给自己排闹钟"。节律权在插件手里——外部间隔、概率、睡眠时段、每日额度都由宿主侧计时器掌管；模型既不预约下一次，也不知道下一次什么时候来。被唤醒的那一轮，模型拿到的是一段标注为非用户来源的自检提示，它可以说话、可以做事、也可以什么都不做，并用自己的话交代理由。

## 与 dsh-proactive 的区别

| | dsh-proactive | 本插件 |
| --- | --- | --- |
| 谁决定何时醒 | 模型自己排闹钟（once/every/cron/file） | 宿主按平均间隔 + 抖动掷骰 |
| 概率 | 排了就一定触发 | 每次按 `probability` 掷，可 `adaptive` 随距上次活动变化 |
| 睡眠时段 | quiet hours 抑制投递 | 睡眠窗口内不掷骰（自排唤醒可豁免） |
| 意图台账 | 无 | 想法 / 约定两类，带版本与状态机 |
| 判断记录 | 每次投递一条 run | 每次掷骰命中一条 run，记 trigger / decision / reason / 起止时间 |

节律语义对齐 AstrBot 的 `astrbot_plugin_autonomy`（上游原版 `whalelife-plugin-autonomy`）：掷骰、概率、自适应倍率、睡眠窗口（含跨夜与跨周）、意图台账、判断记录、面板手动触发，这些行为一一对应；上游的 `allowSelfWake`、`timezone`、`motivation`、`requestId` 幂等、九态判断记录与「重启不重放」恢复语义也已搬过来。差异是本插件跑在 DSH 的宿主侧，用 `agents` 服务唤醒任意受管会话（冷会话会先恢复），而不是借助渠道插件的定时任务。

## 安装

```bash
dsh plugin add <本仓库路径或包名>
```

插件以 `cordis.patch.yml` 声明 bundle，宿主热加载即可生效，无需重启。

## 配置

配置落在 `<DSH_HOME>/autonomy/config.json`，面板可改，也可直接编辑后刷新。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后不再掷骰，手动触发仍可用 |
| `intervalMinutes` | `30` | 平均多久掷一次骰 |
| `jitterRatio` | `0.1` | 抖动比例，实际等待 = 间隔 ×(1 ± 抖动)。设 `0.5` 即上游「50%～150%」语义 |
| `probability` | `0.2` | 每次掷骰唤醒的概率 |
| `mode` | `fixed` | `fixed` 用原概率；`adaptive` 按距上次活动调整 |
| `adaptive.recentMinutes` | `20` | 距上次活动小于此值视为"刚聊过" |
| `adaptive.recentMultiplier` | `0.15` | 刚聊过时概率乘数 |
| `adaptive.distantMinutes` | `360` | 距上次活动超过此值视为"冷落已久" |
| `adaptive.distantMultiplier` | `1.5` | 冷落已久时概率乘数 |
| `sleepWindows` | `[]` | 如 `["23:00-08:00"]`；支持跨夜、多段，以及 `"23:00-08:00@5-1"` 这种「周五 23:00 → 周一 08:00」的跨周窗口（0=周日…6=周六） |
| `timezone` | `""` | 判断用的时区；留空用宿主时区 |
| `allowSelfWake` | `true` | 是否允许模型用 `autonomy_schedule` 给自己排唤醒 |
| `motivation` | `""` | 覆盖自主回合开场那段「决定做什么」的文案；留空用内置 |
| `selfWakeDuringSleep` | `false` | 模型自排的唤醒是否允许落在睡眠窗口 |
| `maxRunsPerDay` | `20` | 每日判断次数上限，`0` 不限 |
| `minIdleMinutes` | `0` | 距上次活动不足此值则不掷骰 |
| `sessions` | `[]` | 目标会话；留空则管理全部根会话 |
| `maxRuns` / `maxIntents` | `20` / `50` | 每个会话保留的记录条数 |

## 测试

```bash
pnpm test      # core 纯逻辑 + 宿主契约测试
```

- `test/core.test.ts`：间隔抖动、概率（fixed/adaptive）、睡眠窗口（跨夜/跨周/坏配置）、意图状态机、判断记录状态机。
- `test/contracts.test.ts`：`quiet-contract`（睡眠期不醒且不丢安排）、`queue-contract`（自排优先于随机、原子消耗、未命中照常推进时钟）、`daily-budget`、`recovery-contract`（重启时在飞的判断判中断不重放）、`settling`、`cancel-contract`。

## 工具

模型在会话里可以调用三个工具：

- `autonomy_schedule`：`get` 看待机状态，`set` 指定 `at`（`YYYY-MM-DDTHH:MM`）或 `in_minutes` 排一次自排唤醒，`cancel` 撤销。`set`/`cancel` 都支持 `version`（陈旧版本拒覆盖）与 `requestId`（同一 id 重复提交不重排）。`allowSelfWake=false` 时 `set`/`cancel` 一律拒绝。
- `autonomy_intents`：`list` 看未完成意图，`remember` 记一条（`kind=agreement` 必须给 `due_at`），`revise` 改，`complete` / `abandon` 收尾（都要带 `version` 防覆盖）。
- `autonomy_finish`：结束当前自主轮，`decision` 取 `acted` 或 `no_action`，`reason` 一句话。只对进行中的 run 有效；不调用也能收尾，此时按事件日志推断。

## 面板

设置 → Autonomy：

- 配置区：上面 12 个常用键，保存即写盘。
- 会话区：`现在判断一次`、`取消自排唤醒`、`结束并取消排队`。
- 意图台账：新增、完成、放弃。
- 最近的判断：trigger / status / decision 徽章 + 理由 + 时间。

面板走 `/api/dsh-autonomy/{state,action,events}`，前端通过 SSE 自动刷新。

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
pnpm test         # 43 个用例，覆盖抖动、概率、跨夜与跨周窗口、意图状态机、run 生命周期、宿主契约
```

`src/core/` 是纯逻辑，不依赖任何 `@deepseek-ai` 包，可单独测试。

## 已知边界

- 冷会话优先走宿主的 `sessionController.resolveAgent` 恢复（带预设与模型），控制器不在的宿主才退回 `agents.resume`；恢复失败时该次计入 `failed` 并留下错误文本。
- `minIdleMinutes` 依赖宿主写入的活动时间；长时间空闲的会话会按自适应倍率提高概率。
- 面板展示的是最近 20 条判断、50 条意图（可在配置里调整保留条数）。

## 致谢

外部节律掷骰、意图台账、判断记录与面板的设计出自[iinukami/whalelife-plugin-autonomy](https://github.com/iinukami/whalelife-plugin-autonomy)，配置项与工具命名也沿用其约定。本仓库是在DSH插件API上的独立实现，未复制其源码。
