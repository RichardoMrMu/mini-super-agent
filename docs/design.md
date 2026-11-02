# 设计复核与独立测试结论（2026-11-02）

本文档记录独立复核（只写 `README.md` / `docs/` / `tests/` /
`LICENSE` / `THIRD_PARTY_NOTICES.md`，不改 `src/`）对最终实现的结论。

## 1. 接口与实现差异核对（与最终 src 对齐）

| 契约点 | 最终实现 | 探针/证据 |
| --- | --- | --- |
| queued 任务收 cancel | 同 tx 立即 `cancelled`：杀 queued assignment、filter queued input、写 reply outbox | `CANCEL-QUEUED` |
| running 任务收 cancel | 只写意图 `cancelling`，slot 保留到模型边界 | `CANCEL-RUNNING` |
| boot 恢复 running | → `queued`，保持 stepsDone/checkpoint；旧 running assignment 归 `reported`；**直接插新 assignment**（不重 enqueue `launch:<taskId>`，防 UNIQUE） | `BOOT-RUNNING` / `BOOT-ASSIGNMENTS` |
| boot 恢复 cancelling | 直接 `cancelled`，不重启 | `BOOT-CANCELLING` |
| boot orphan effect | `running` 态 effect 全部 reset `due`（重投，at-least-once） | `BOOT-EFFECTS` + recovery trace `1 orphaned effect(s) reset to due` |
| 干净关机 | `lastShutdown='clean'` → 不动任何任务 | `BOOT-CLEAN` |
| intake 幂等 | eventId 先查 disposition，重投返回 `duplicate` 不再过策略门 | `INTAKE-DUP` + recovery trace 全部 `duplicate` |
| channel 去重 | `channel.db` 独立 messageId 去重；naive 不去重作对照 | `02-channel-db` + `stage4-dedup.jsonl` 4 条 reply 全 attempt=1 |
| doctor | 只读 detect，不改 state 文件 | `CLI-DOCTOR-RO`（SHA256 前后不变） |

## 2. 测试计数（最终 build）

`npm test`（= build + `node --test tests/*.test.mjs`，Node v22.23.2）：

**37 tests / 37 pass / 0 fail / exit 0**

| 文件 | 条数 | 覆盖 |
| --- | --- | --- |
| `tests/01-schema.test.mjs` | 7 | events.json schema v1、eventId 命名、task 耦合 |
| `tests/02-channel-db.test.mjs` | 3 | dedup 抑制 / naive 对照 / 不同 messageId 不受影响 |
| `tests/03-engine-db.test.mjs` | 4 | tx 回滚、effect 稳定 key、reset running、input 消费 |
| `tests/04-intake.test.mjs` | 7 | message 存储、幂等、passthrough 开关、queued cancel、running cancel、晚到 followup |
| `tests/05-recovery.test.mjs` | 5 | boot running/cancelling/clean/orphan effect + 新旧 assignment 行终态（独立只读连接直查） |
| `tests/06-state-lock.test.mjs` | 5 | fresh / live pid 拒绝 / dead pid 接管 / malformed fail-closed / release |
| `tests/07-cli.test.mjs` | 6 | stage1 trace、crash-step 双跑、crash-claim 重读同一 claimed input 只消耗一次、crash-send naive 双发、dedup 压成一条、doctor 只读 |

## 3. 红绿变异证据

仓库外 scratch 副本：把 `dist/channel-db.js` dedup 分支改为 `if(false)`
（去重失效），`02-channel-db` 的 DEDUP 探针精准变红（exit 1，
`displayCount=2 ≠ 1`），NAIVE / DEDUP-KEY 仍绿。`src/` 零改动。

## 4. 已知边界（不扩大生产保证）

- 教学仓库零 API Key；真实模型 / GitHub 只是可选扩展接口，未接通。
- 不声明端到端 exactly-once：`channel.db` 只压通道侧重复投递，外部
  副作用靠下游幂等。
- 单进程教学实现：不做多进程租约 / 事件溯源；不保证并发 stale 接管、
  PID 复用、网络 FS 上的 LOCK。
- "模型前 crash（tx#1 只读 snapshot 后、tx#2 checkpoint 前）+ pending input
  重读"已闭环：`CLI-RECOVERY-CLAIM` 实测首跑 stepsDone=1、input queued、
  仅 step1 完成、exit=13；二跑 resumedFrom=1、step2 同一 input 只消耗一次、
  通道侧仅 1 条 reply。注意 tx#1 是**内存只读 snapshot**，没有持久 claim 行——
  持久的只有前序 step checkpoint；崩溃后 pending inputs 整体重读。
