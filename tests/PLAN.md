# tests/PLAN.md — 黑盒探针计划（契约 → 反例 → oracle）

> 测试只通过公开 CLI / 导出函数观察，**不读 `src/` 内部**。
> 最高风险探针的 RED 证据在**仓库外临时副本**上取，绝不改 `src/`。
> 从仓库根运行：`npm test`（= `npm run build && node --test tests/*.test.mjs`）。

## A. 契约域（保证"做对了"）

| 探针 | 保护的不变量 | 错误实现（变异） | GREEN oracle |
| --- | --- | --- | --- |
| `P-HOL-ORDER`（CLI-STAGE1） | 慢会话后快事件不被提前推进 | 后续会话先于慢会话完成 | 阶段1 trace：B intake 时间戳严格 > A 完成时间戳 |
| `P-HOL-TIME` | 顺序执行总耗时 ≈ 各事件之和 | 并发被伪装成"立即返回" | stage1 at 时间戳单调累加 |
| `P-HOL-NO-ADVANCE` | 慢结果未回时后续会话状态不变 | 假装并发、不等 await | 无后续 intake 记录 |
| `P-ROUTER-STICKY` | 同 conv 单 worker | 同 conv 跨 worker 乱序 | stage2 trace 同 conv 完成序与事件序一致 |
| `P-ROUTER-PARALLEL` | 不同 conv 真并行 | 锁退化成顺序 | stage2：A/B boot 时间戳相同 |
| `P-SPILL-NOT-INLINE` | spill 正文不进模型输入 | spill 当 inline 内联 | 后续模型输入只含引用 id |
| `P-INLINE-VISIBLE` | inline 结果内联可见 | inline 也落 spill | inline 结果出现在会话上下文 |
| `P-CANCEL-MODEL-BOUNDARY` | cancel 不硬杀模型，slot 保留 | cancel 立即停模型 | 任务停在模型边界，不是 step 中间 |
| `P-CANCEL-RESTART` | cancelling 重启 → cancelled | cancelling 重启复活 | boot trace：cancelling→cancelled |
| `P-CANCEL-RACE` | finish/cancel 先提交者胜 | 内存标志判胜负 | 无竞态期间崩溃后歧义状态 |
| `P-APPEND-LOST` | finish 不丢未消费 append | 完结时静默吞 append | append 计数对账一致 |
| `P-LATE-NEW-TASK` | 完结后晚到新 task 独立触发 | 新 task 被同 conv 完结态吞掉 | 新 task 出现在 trace |
| `P-ATOMIC-OUTBOX` | 领域 + outbox 同 tx | outbox 在 tx 外写 | 任一方缺失则整体回滚 |
| `P-RECOVERY-REREAD` | T1 后崩溃 → pending input 重读一次 | 崩溃后跳过输入 | 同一 input 仅被消费一次（dedup 通道） |
| `P-RECOVERY-CHECKPOINT` | T2 后崩溃 → 从 checkpoint 恢复，不重跑模型 | 崩溃后从 step0 重跑 | boot 记录 resumedFrom=N |
| `P-WORKDIR-REBUILD` | workdir 删掉可从 SQLite 重建 | workdir 是恢复唯一依据 | 删 workdir 后恢复仍成功 |
| `P-DEDUP-SUPPRESS` | messageId 去重压掉重发 | 去重失效 | 同 messageId 下游收到一条 |
| `P-DEDUP-NAIVE` | naive 对照双发 | naive 偷偷去重 | 窗口内崩溃重发，下游两条 |
| `P-POISON-DROP` | 毒消息 3 次重试 dropped 放行 | 无限重试堵 FIFO | 毒消息后队列继续推进 |
| `P-WX-LIVEPID` | 活 pid（含 EPERM）拒绝启动 | 活 pid 被当 stale 覆盖 | `refused-live-pid`，不覆盖 LOCK |
| `P-WX-DEADPID-TAKEOVER` | 死 pid stale → 单一启动器接管 | 死 pid 也拒绝 | 本实例 pid 写入 LOCK |
| `P-SCHEMA-REJECT` | 未知 schema 即拒绝 | 静默迁移 | 启动报错退出 |
| `P-DOCTOR-RO` | doctor 只读 detect | doctor 修 state | doctor 运行前后 state 哈希不变 |

## B. 变异说明（每个错误实现对应的测试文件 / 探针）

| 错误实现 | 变异位置（仓库外副本） | 对应探针 | RED 现象 |
| --- | --- | --- | --- |
| 去重失效 | `dist/channel-db.js` dedup 分支改 `if(false)` | `02-channel-db` DEDUP | `displayCount=2 ≠ 1`，exit 1 |
| tx 部分提交 | 去掉 `BEGIN IMMEDIATE` | `03-engine-db` TX-ROLLBACK | 回滚后 effect 残留 |
| effect key 不唯一 | 去掉 `UNIQUE` / `INSERT OR IGNORE` | `03-engine-db` EFFECT-KEY | dueEffects 长度=2 |
| running effect 不清 | 去掉 `resetRunningEffects` | `03-engine-db` RESET-RUNNING | dueEffects 长度=0 |
| intake 不幂等 | 去掉 eventId 先查 | `04-intake` INTAKE-DUP | 第二任务 / 双 launch effect |
| pass-through 未开仍 append | 去掉 `passThrough` 门 | `04-intake` PASSTHROUGH-OFF | queuedInputs 长度=1 |
| queued cancel 不立即终态 | 删 queued 分支 | `04-intake` CANCEL-QUEUED | task=cancelling 而非 cancelled |
| boot cancelling 复活 | 去掉 cancelling→cancelled | `05-recovery` BOOT-CANCELLING | task=cancelling |
| boot running 清进度 | 去掉 stepsDone 保留 | `05-recovery` BOOT-RUNNING | stepsDone=0 |
| live pid 误接管 | 去掉 pidAlive 检查 | `06-state-lock` WX-LIVEPID | acquire='acquired' |
| malformed LOCK 放行 | 损坏解析返回 fresh | `06-state-lock` WX-MALFORMED | acquire='acquired' |
| naive 偷偷去重 | naive 分支加 dedup | `07-cli` CLI-CRASH-SEND-NAIVE | 无 attempt=2 |
| dedup 失效 | 同去重失效 | `07-cli` CLI-CRASH-SEND-DEDUP | reply attempt>1 |

## C. 实测证据索引（`evidence/`）

- `cli-stage1.jsonl` … `cli-stage4.jsonl`：四阶段同 fixture 的 trace。
- `stage4-dedup.jsonl`：dedup 通道下 4 条 reply 全 `attempt=1`（无重发）。
- `recovery-step.txt`：crash-step 首跑 exit=13，二跑恢复完成。
- `recovery-send.txt`：crash-send naive 窗口内 `m-end-B` attempt=2 双发；cancelling→cancelled 不复活。
- `recovery-crash-step.stdout.txt` / `recovery-crash-step.txt`：首跑崩溃点 stderr 证据。
- `recovery-claim.txt`：crash-claim 首跑 stepsDone=1 / input queued，二跑 resumedFrom=1。
