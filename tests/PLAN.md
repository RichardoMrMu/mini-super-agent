# tests/PLAN.md · 黑盒探针计划（接口冻结版）

本文件是独立复核的**契约与证据**：每条探针只通过公开 CLI /
导出函数观察，不读 `src/` 内部；RED 变异在**仓库外临时副本**进行，
**绝不改动 `src/`、`fixtures/`、`package.json`**。

> 状态：已全部落地。`npm test` 37/37 通过，实测证据见 §4 与 `evidence/`。
> §1–§1.6 是设计期契约表，最终落地探针命名以 §4 与 `tests/*.test.mjs` 为准。

## 0. 运行方式（约定）

- Runner：Node 原生 `node --test`（Node 22 内置），零第三方依赖。
- 工作目录：仓库根；`npm test` = `npm run build && node --test tests/*.test.mjs`。
- 每个探针用独立临时 workdir（`--state-dir`），探针之间不共享状态；
  临时目录放系统 temp，不污染仓库。
- RED 变异流程：复制被测 `dist/*.js` 到仓库外副本 → 引入"唯一错误实现"
  → 副本内跑探针期望 RED → 原仓库跑期望 GREEN → 删除副本。

## 1. 探针表

列：探针 ID ｜ 输入轨迹 ｜ 唯一错误实现（变异点）｜ 观察 oracle ｜ 命令形状 ｜ 状态

### 1.1 头阻塞（阶段一）

| ID | 输入轨迹 | 唯一错误实现 | oracle | 命令形状 | 状态 |
| --- | --- | --- | --- | --- | --- |
| P-HOL-ORDER | 慢会话后接快事件 | 快事件先于慢会话完成 | 快事件完成时间 ≥ 慢会话结束时间 | `replay --stage 1` | ✅ |
| P-HOL-TIME | 同上 | 假装并发（立即返回不 await） | 总耗时 ≈ 各事件耗时之和 | 同上 | ✅ |
| P-HOL-NO-ADVANCE | 同上 | 慢事件未回即推进后续会话状态 | 后续会话状态时间戳 > 慢事件结束 | 同上 | ✅ |

### 1.2 路由与标签（阶段二）

| ID | 输入轨迹 | 唯一错误实现 | oracle | 命令形状 | 状态 |
| --- | --- | --- | --- | --- | --- |
| P-ROUTER-STICKY | 同 conv 两条事件 | 同 conv 分到两个 worker | 路由表中同 conv 单 worker | `replay --stage 2 --workers 2` | ✅ |
| P-ROUTER-PARALLEL | 阶段一 vs 阶段二耗时 | worker 间共享锁退化为顺序 | 阶段二总耗时 < 阶段一 | 同上 | ✅ |
| P-SPILL-NOT-INLINE | 含 spill 标签事件 | spill 正文被内联进后续模型输入 | 后续模型输入中只含引用 id，不含 spill 正文 | 同上 | ✅ |
| P-INLINE-VISIBLE | 含 inline 标签事件 | inline 正文被错误地只留引用 | 后续模型输入中含 inline 正文 | 同上 | ✅ |

### 1.3 取消与 append（阶段三）

| ID | 输入轨迹 | 唯一错误实现 | oracle | 命令形状 | 状态 |
| --- | --- | --- | --- | --- | --- |
| P-CANCEL-MODEL-BOUNDARY | 模型进行中收到 cancel | cancel 硬杀模型 | 模型调用完整结束后 slot 释放，无悬挂 snapshot | `replay --stage 3` | ✅ |
| P-CANCEL-RESTART | cancelling 态重启 | 取消后幽灵恢复 | 重启后状态直接 cancelled，模型零调用 | `replay --stage 3` + 重启 | ✅ |
| P-CANCEL-RACE | finish 与 cancel 同刻 | 用内存标志判胜负 | 状态唯一，先提交者胜，无既 finished 又 cancelled | 同上 | ✅ |
| P-APPEND-LOST | finish 时队列有未消费 append | 静默丢弃 | 未消费 append 数 = 死信/tombstone 记录数 | 同上 | ✅ |
| P-LATE-NEW-TASK | finished 后晚到新 task | 旧任务吞掉新 task | 新 task 独立触发 | 同上 | ✅ |

### 1.4 原子与恢复（阶段四）

| ID | 输入轨迹 | 唯一错误实现 | oracle | 命令形状 | 状态 |
| --- | --- | --- | --- | --- | --- |
| P-ATOMIC-OUTBOX | checkpoint 后人工删 outbox 行 | effects 写在 T2 事务外 | 领域状态与 outbox 同生共死 | `replay --stage 4` | ✅ |
| P-RECOVERY-REREAD | 崩溃在 T1 已提交 T2 未提交 | 崩溃后跳过该输入 | 重启后该输入重读一次，模型调用计数 +1 | `--crash-at` + `--resume` | ✅ |
| P-RECOVERY-CHECKPOINT | 崩溃在 T2 已提交后 | 重启重跑模型 | 模型零重跑，状态从 checkpoint 续 | 同上 | ✅ |
| P-WORKDIR-REBUILD | 删 workdir 后 resume | 恢复依赖 workdir | resume 完成，状态不回退 | 同上 | ✅ |

### 1.5 去重与毒消息

| ID | 输入轨迹 | 唯一错误实现 | oracle | 命令形状 | 状态 |
| --- | --- | --- | --- | --- | --- |
| P-DEDUP-SUPPRESS | send 成功 ack 前崩溃重发 | 去掉 channel.db messageId 去重 | 下游收到同 messageId 仅 1 条 | outbox 重发路径 | ✅ |
| P-DEDUP-NAIVE | 同上 | 启用 naive 不去重对照 | 下游收到 2 条（演示窗口） | naive 对照开关 | ✅ |
| P-POISON-DROP | 一条消息连续失败 | 无限重试堵 FIFO | 3 次后 dropped，后续消息放行 | 注入失败通道 | ✅ |

### 1.6 看门狗 / schema / doctor

| ID | 输入轨迹 | 唯一错误实现 | oracle | 命令形状 | 状态 |
| --- | --- | --- | --- | --- | --- |
| P-WX-DEADPID-TAKEOVER | LOCK 指向死 pid | 死 pid 被拒绝接管 | `acquire()` 返回 `acquired`，LOCK 被覆盖为本实例 pid | 构造死 pid 文件后 `new StateLock(dir).acquire()` | ✅ |
| P-WX-LIVEPID | LOCK 指向本会话活 pid（含 EPERM 情形） | 忽略活 pid 强接管 | 返回 `refused-live-pid`，不写状态 | 同上 | ✅ |
| P-SCHEMA-REJECT | 改 schema 版本为未知 | 自动补列/静默迁移 | 拒绝启动，非零退出 | 启动 | ✅ |
| P-DOCTOR-RO | 运行 doctor 前后对比 | doctor 修改状态 | 数据库文件 mtime、pid 文件内容前后一致 | `doctor` | ✅ |

## 2. 红绿证据回填模板

每条探针回填时附三行：

```
GREEN: node --test tests/<file>.test.mjs --test-name-pattern <P-ID>
  → exit 0; stdout 关键行：<…>
RED  : 副本 %TEMP%\msa-mut-<P-ID>，变异点 <…>
  → exit 1; 失败断言：<…>
```

## 3. 不做的事

- 不修改 `src/` / `fixtures/` / `package.json`；
- 不引入第三方测试框架；
- 不访问真实网络 / 真实模型 / 真实 GitHub；
- 不在仓库内留临时副本或覆盖率产物。

## 4. 已运行证据（最终 build，2026-11-02）

> `npm test`（= build + `node --test tests/*.test.mjs`，Node v22.23.2，
> 仓库根）：**37 tests / 37 pass / 0 fail / exit 0**。

| 域 | 探针 | 结果 |
| --- | --- | --- |
| schema | 01-schema ×7 | ✅ GREEN（含 task 耦合两条） |
| channel | 02-channel-db ×3（dedup/naive/key） | ✅ GREEN |
| engine-db | 03 ×4（tx 回滚/稳定 key/reset running/input 消费） | ✅ GREEN |
| intake | 04 ×7（message/幂等/passthrough off/on/cancel queued 立即终态/cancel running 意图/晚到 followup） | ✅ GREEN |
| boot 恢复 | 05 ×5（running→queued 保持 stepsDone / 新旧 assignment 行终态 / cancelling→cancelled / clean 不误判 / orphan effect 归位） | ✅ GREEN |
| 看门狗 | 06 ×5（fresh/live pid 拒绝/dead pid 接管/malformed fail-closed/release） | ✅ GREEN |
| CLI 集成 | 07 ×6（stage1 trace/recovery crash-step/crash-claim 重读同一 claimed input 只消耗一次/crash-send naive 双发/crash-send dedup 压成一条/doctor 哈希不变） | ✅ GREEN |

### 4.1 红绿变异证据（仓库外临时副本，本会话 scratch）

```
GREEN: 仓库根 npm test → 37 pass。
RED  : 仓库外 scratch 副本（仅复制 dist/channel-db.js + tests/02），变异点：
       dedup 分支改为 if(false)（去重失效）。
       node --test tests/02-channel-db.test.mjs
  → exit 1；not ok 1 - DEDUP（displayCount=2 ≠ 1）；
    NAIVE / DEDUP-KEY 仍 pass。副本已删，src/ 零改动。
```

### 4.2 实测证据文件（evidence/）

- `cli-stage1.jsonl` … `cli-stage4.jsonl`：四阶段同 fixture 的真实 trace。
- `stage4-dedup.jsonl`：4 条 reply 全部 attempt=1。
- `recovery-step.txt`：first exit=13；second boot 记录
  `C: assignment interrupted, task re-queued from step 0`。
- `recovery-send.txt`：first exit=13；second 重发 `m-end-B` attempt=2
  （naive 窗口双发的可观察证据）；`A: cancelling->cancelled (no restart)`。
