# 00 · 架构与冻结合同（Frozen Contract）

本文是全部不变量的**唯一权威来源**。四课（01–04）、测试计划
（`tests/PLAN.md`）、矩阵（05）都必须与本文逐字一致；如发现不一致，
以本文为准并回改其他文件。

> 状态：**接口冻结，已全部实测**。公开入口 `dist/cli.js` 与导出函数均已
> 交付，`npm test` 37/37 通过；实测证据见 `evidence/` 与 `docs/design.md`。

---

## 1. 它是什么、不是什么

- **是**：一个事件驱动的最小 Agent 运行时教学原型。输入是一份确定性
  事件流 `fixtures/events.json`，输出是可观察的日志、SQLite 状态与
  outbox 记录。
- **不是**：生产框架。不接真实模型、不接真实通道、不做多机部署、
  不做 exactly-once 投递承诺。所有"真实"部分（模型、send）都是
  确定性 mock + 对照实现。

## 2. 四阶段消费同一份 fixture

四个阶段**逐字消费同一份 `fixtures/events.json`**，不修改 fixture 内容，
只切换引擎配置与崩溃注入点：

| 阶段 | 配置开关 | 教学目标 | 对照失败 |
| --- | --- | --- | --- |
| 1 | 单 worker、无 outbox、无持久化 | 单会话 `await` 造成后续事件延迟（head-of-line） | 一个慢会话堵死整队 |
| 2 | Router + N workers、确定性 mock，回复标签 `inline` / `spill` | 并发分发与标签路由 | 错误地把 `spill` 当 `inline` 内联消费 |
| 3 | 开 open task：普通 thread 消息订阅直通 `append` / `cancel` | 取消语义、完结后晚到新 task | 取消后幽灵恢复；finish 丢未消费 append |
| 4 | 开 SQLite 持久化 + outbox | 崩溃恢复、同事务提交边界 | 模型成功但提交前崩溃 → 输入重读；已提交 → context 恢复 |

## 3. 引擎事务边界（核心不变量）

### 3.1 每命令一个原子事务

- 每条命令（一条输入事件被处理）对应**一个原子事务**：
  领域状态变更 + `effects/outbox` 写入，要么一起提交，要么一起回滚。
- `aftercommit` 钩子**只负责唤醒等待者**，绝不在事务内执行副作用。
  副作用（发消息、调模型）一律在事务外发生。
- handler 投递语义为 **at-least-once**，用**稳定 key**（messageId /
  事件 id）去重；任何 handler 都必须容忍被重复调用。

### 3.2 模型边界的提交顺序

一次模型调用的生命周期：

```
[事务 T1] snapshot 输入（内存只读读取 queued inputs，不落"claim 行"）
        │
        ▼   （事务外）调用确定性 mock 模型
        │
[事务 T2] step checkpoint（推进会话状态）
        + consumedIds（标记该输入已消费）
        + effects/outbox（待发副作用）
        三者同事务提交
```

崩溃语义：

- 崩溃发生在 **T1 提交后、T2 未提交** → 没有任何持久的"claim"记录，
  重启后 pending inputs **整体重读**，模型可能再跑一次 → 这是
  at-least-once 的代价，由下游 messageId 去重兜底。
- 崩溃发生在 **T2 已提交** → 重启后从 checkpoint **恢复 context**，
  不会重跑模型。
- `workdir/` 里的一切只是**可重建产物**（中间文件、日志、转储），
  崩溃恢复不依赖它；删了能从 SQLite 重建。

### 3.3 cancel 语义（已按最终实现核对）

- **cancel 只是意图**，但分两种落点：
  - 任务 `queued`（从未起跑）→ 同一事务内**立即终态 `cancelled`**：
    杀掉未跑的 assignment、把未消费 input 标记 filtered、写 reply outbox。
  - 任务 `running` → 只写**意图** `cancelling`；running slot 保留到模型
    边界退出，在 step 事务内判定终态。
- **finish 与 cancel 的提交竞争**：谁先提交谁赢（first commit wins）。
- 任务处于 `cancelling` 态时进程崩溃 → boot 恢复直接判 `cancelled`，
  不复活（见 `evidence/recovery-send.txt` 首行恢复记录）。
- **finish 不得丢未消费 append**：队列里未消费的 append 由 runner 再跑
  一个 step 消费（queued cancel 路径则直接 filter 入死信）。

### 3.4 boot 恢复（已按最终实现核对）

崩溃重启后（`meta.lastShutdown='running'`）：

- `running` 任务 → 置回 `queued`，**保持 stepsDone 与已提交 checkpoint**，
  旧 assignment 标记终态，**直接插入新 assignment**（不重 enqueue
  `launch:<taskId>` effect——它的 UNIQUE key 已存在）；
- `cancelling` 任务 → 直接 `cancelled`，永不重启；
- 残留 `running` 态 effect → 全部重置 `due`（孤儿重投，at-least-once）。
- 干净关机（`lastShutdown='clean'`）→ 不动任何任务。

## 4. 通道与 outbox（channel.db）

- `channel.db` 是**独立持久化**的 messageId 去重表，与引擎主库分离。
- 引擎 ack **在另一个事务**里发生：流程是
  `outbox 标记待发 → 真实 send（mock）→ ack（另一 tx）`。
- **必然崩溃窗口**：send 已成功、ack 未提交时崩溃 → 重启重发。
  因此端到端**不声明 exactly-once**；本仓库用一个 naive 不去重的
  对照实现演示"窗口内重发 = 双发"，再用 `channel.db` messageId 去重
  演示"重发被压成一条"。
- **FIFO / head-of-line**：同一 conversation 内严格顺序；毒消息
  （连续失败）重试 **3 次后 dropped 放行**，不阻塞后续消息。

## 5. 看门狗 / 单实例（wx）

- 启动时读取 `stateDir/LOCK`：
  - pid **存活**（包括跨用户 EPERM 拒绝信号）→ 返回 `refused-live-pid`，
    拒绝启动，不报假恢复；
  - pid **已死** → 视为 stale，**由单一恢复启动器接管**（教学路径），
    LOCK 被覆盖写成本实例 pid。
- 本仓库**仅支持单一恢复启动器**这一条路径，教学目的是展示边界，
  不保证：并发 stale 接管、PID 复用误判、网络文件系统上的 pid 文件语义。
  （实现见 `src/lock.ts` 的 `StateLock.acquire()`。）

## 6. schema 与 doctor

- 数据库 schema 版本**未知即拒绝启动**（不自动迁移、不静默补列）。
- `doctor` 是**外部只读 detect**：只报告 schema 版本、pid 状态、
  可恢复标记、日志位置；**不 kill 进程、不改任何 state**。

## 7. 接口形状

> 下列条目均已从最终 `src/` 实际读出并被黑盒测试覆盖。

### 7.1 公共导出（`src/*.ts`，构建后位于 `dist/`）

| 模块 | 导出 | 形状 |
| --- | --- | --- |
| `types.ts` | `RunOptions` | `{ stage: 1\|2\|3\|4; eventsPath: string; stateDir: string; workers: number; channel: 'naive'\|'dedup'; outPath?: string }` |
| `engine-db.ts` | `EngineDb.open(path)` | `.tx(fn)` / `.close()` / tasks / inputs / steps / effects / receipts / meta 方法族 |
| `channel-db.ts` | `ChannelDb.open(path, mode)` | `.send(messageId, conversationId, body, attempt, at) → {displayed, attempt}` / `.displayCount(messageId)` |
| `lock.ts` | `new StateLock(stateDir)` | `.acquire() → 'acquired' \| 'refused-live-pid' \| 'refused-malformed-lock'` / `.release()` |
| `schema.ts` | `loadEvents(path)` / `eventIdOf(e)` | 未知 key 即 throw `schema_v1: …`；`schema` 必须为 `"v1"` |

### 7.2 fixture schema

`fixtures/events.json`：根 `{ "schema": "v1", "events": [事件数组] }`；事件字段
`at(整数) / type(message|followup|cancel) / threadId / taskId / body`，
仅 `message` 可带 `task: {steps≥1, stepMs≥0, spill:boolean}`；
未知 key 拒绝。主 fixture 共 7 条事件（t1: A 任务→followup→cancel→晚到追问→新任务D；
t2: B；t3: C）。crash-claim 场景另用 `fixtures/recovery-checkpoint.json`。

### 7.3 已落地的 CLI 与崩溃注入

| 接口 | 形状 |
| --- | --- |
| 运行 | `node dist/cli.js run --stage <1\|2\|3\|4> [--events f] [--state-dir d] [--workers N] [--channel naive\|dedup] [--out p]` |
| 恢复场景 | `node dist/cli.js recovery --scenario <crash-step\|crash-send\|crash-claim> [--state-dir d] [--out p]` |
| 只读自检 | `node dist/cli.js doctor --state-dir d`（JSON 输出，不改 state） |
| 测试 | `npm test` = `npm run build && node --test tests/*.test.mjs` |
| 崩溃注入 env | `MOCK_CRASH_AT_STEP=<task>:<step>`（step 开始 exit 13）；`MOCK_CRASH_AFTER_SEND=1`（send 后 ack 前 exit 13）；`MOCK_CRASH_AFTER_CLAIM=<task>:<step>`（tx#1 只读 snapshot 后、tx#2 checkpoint 前 exit 13） |
| 退出码 | 正常 0；注入崩溃 13；用法错误 2 |
