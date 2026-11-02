# 04 · 第四课：SQLite 持久化与崩溃恢复

> 阶段四配置：开 SQLite 持久化 + outbox。消费同一份 `fixtures/events.json`。

## 1. 代码入口

```powershell
node dist/cli.js recovery --scenario crash-step  --state-dir state/recovery
node dist/cli.js recovery --scenario crash-claim --state-dir state/recovery
node dist/cli.js recovery --scenario crash-send  --state-dir state/recovery
node dist/cli.js doctor --state-dir state/recovery
```

`recovery` 子命令自己跑两次：第一次按注入点 `exit 13`，第二次正常恢复。
退出码 0；节录见 `evidence/recovery-step.txt`、`recovery-send.txt`。

## 2. 讲解

把第三课的运行时落进 SQLite。关键是两个事务的位置（见
`docs/00-overview.md` §3.2）：

```
T1: snapshot 输入（内存只读读取 queued inputs，不落 claim 行）
    ──── 事务外：调 mock 模型 ────
T2: step checkpoint + consumedIds + effects/outbox   ← 三者同 tx
```

崩溃注入点有三个教学位置：

| 崩溃位置 | 重启后行为 | 你该观察到 |
| --- | --- | --- |
| step 开始（`MOCK_CRASH_AT_STEP`） | running→queued 保持 stepsDone，重跑该步 | boot 记录 `re-queued from step N` |
| T1 之后、T2 之前（`MOCK_CRASH_AFTER_CLAIM`） | 没有持久 claim，pending inputs **整体重读**，模型再跑一次 | 同一 input 只在恢复后被消费一次 |
| send 后 ack 前（`MOCK_CRASH_AFTER_SEND`） | outbox 重发 | naive 双发 / dedup 压一条（见 `docs/07`） |

schema 版本未知 → 拒绝启动（不自动迁移）。`doctor` 只读 detect，
不 kill 不改 state。

## 3. 真实可观察输出（节录）

`recovery --scenario crash-step`：
```
# first exit=13 / second exit=0
{"kind":"boot","crashed":true,"recovered":["C: assignment interrupted, task re-queued from step 0"]}
```

`recovery --scenario crash-claim`（`fixtures/recovery-checkpoint.json`）：
```
# 首跑 stepsDone=1、input queued、仅 step1 完成、exit=13
# 二跑 resumedFrom=1、step2 同一 input consumed、通道侧仅 1 条 reply
```

## 4. 失败案例

**反例 A：把 effects/outbox 写在 T2 事务外**。
观察现象：checkpoint 提交了、outbox 没落盘 → 重启后状态推进但消息没发。

**反例 B：T1/T2 之间崩溃后不重读**。
观察现象：输入被跳过，会话状态缺一条。

**反例 C：T2 之后崩溃后重跑模型**。
观察现象：模型调用次数多一次。

## 5. 验证 oracle 一一对应

| 观察点 | 期望 | 探针 |
| --- | --- | --- |
| 核心窗口崩溃 | 同一 claimed input 重读且只消耗一次 | `CLI-RECOVERY-CLAIM` |
| boot 恢复 running | 保持 stepsDone、直接插新 assignment | `BOOT-RUNNING` / `BOOT-ASSIGNMENTS` |
| outbox+领域同 tx | 要么都在要么都不在 | `TX-ROLLBACK` / `RESET-RUNNING` |
| 重发不双发（去重） | 下游收到一条 | `CLI-CRASH-SEND-DEDUP` |
| naive 对照 | 双发（演示窗口） | `CLI-CRASH-SEND-NAIVE` |
| doctor 只读 | engine.db 哈希前后不变 | `CLI-DOCTOR-RO` |

上一课：[`03`](03-lesson-open-task-thread.md) ·
下一步：[`05 实现矩阵`](05-implementation-matrix.md)。
