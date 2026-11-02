# 09 · 局限与测试覆盖

## 9.1 已知局限（明确不保证）

| 局限 | 说明 |
| --- | --- |
| 单机单实例 | 不支持多进程/多机；无 leader 租约、无 fencing token |
| PID 复用不防护 | pid 复用会被 `pidAlive` 误判为活实例；教学路径允许死 pid stale 接管，但不解决复用与并发接管 |
| 网络文件系统不保证 | pid 文件 / SQLite 放在 NFS 等网络 FS 上时，文件锁与 EPERM 语义不保证 |
| 无并发 stale 接管 | 只支持单一恢复启动器；第二个实例看到活 pid 直接拒绝 |
| `node:sqlite` 实验特性 | Node 22 启动有 `ExperimentalWarning`，教学接受；生产应换成熟绑定 |
| 零外部依赖 | 不引入测试框架 / ORM / 迁移工具；`node --test` 原生 runner |
| 模型与通道全 mock | 无真实延迟、无真实网络错误码分布 |
| 不声明端到端 exactly-once | 只承诺 at-least-once + 通道侧 messageId 去重（见 `07`） |

## 9.2 测试覆盖原则

- **黑盒**：测试只通过公开 CLI / 导出函数观察，不读 `src/` 内部。
- **原生**：`node --test`，无第三方 runner；从仓库根运行。
- **红绿变异**：最高风险探针的 RED 证据，在**仓库外临时副本**上引入
  错误实现（例如去掉 messageId 去重）取得；**绝不改动 `src/`**。
- **证据形式**：每条探针记录「命令 + 退出码 + 关键 stdout 行 + oracle 断言」。

## 9.3 探针清单（详见 `tests/PLAN.md`）

| 域 | 探针 | 保护的不变量 |
| --- | --- | --- |
| 头阻塞 | `P-HOL-ORDER` / `P-HOL-TIME` / `P-HOL-NO-ADVANCE` | 第一课顺序语义 |
| 路由 | `P-ROUTER-STICKY` / `P-ROUTER-PARALLEL` / `P-SPILL-NOT-INLINE` / `P-INLINE-VISIBLE` | 第二课 sticky 与标签 |
| 取消/append | `P-CANCEL-MODEL-BOUNDARY` / `P-CANCEL-RESTART` / `P-CANCEL-RACE` / `P-APPEND-LOST` / `P-LATE-NEW-TASK` | 第三课取消语义 |
| 原子/恢复 | `P-ATOMIC-OUTBOX` / `P-RECOVERY-REREAD` / `P-RECOVERY-CHECKPOINT` / `P-WORKDIR-REBUILD` | 第四课事务边界 |
| 去重/毒消息 | `P-DEDUP-SUPPRESS` / `P-DEDUP-NAIVE` / `P-POISON-DROP` | outbox 窗口与 FIFO |
| 看门狗/schema | `P-WX-LIVEPID` / `P-WX-DEADPID-TAKEOVER` / `P-SCHEMA-REJECT` / `P-DOCTOR-RO` | 单实例与只读 detect |

## 9.4 覆盖状态

**最终 build（2026-11-02）**：`npm test`（build + `node --test tests/*.test.mjs`，
Node v22.23.2）→ **37 tests / 37 pass / 0 fail / exit 0**。
分项：schema 7 / channel 3 / engine-db 4 / intake 7 / recovery 5 / lock 5 / CLI 6。

- 低层契约 29 条（schema 7 / channel 3 / engine-db 4 / intake 6 /
  boot 恢复 4 / 看门狗 4 + 1 早期），CLI 集成 5 条。
- 红绿变异：scratch 副本把 `channel-db.js` dedup 分支改 `if(false)`，
  DEDUP 探针精准变红（NAIVE/DEDUP-KEY 不受影响）。
- 实测证据：`evidence/cli-stage1..4.jsonl`、`stage4-dedup.jsonl`
  （4 条 reply 全 attempt=1）、`recovery-step.txt`（first exit=13，
  C 从 step 0 重跑完成）、`recovery-send.txt`（naive 窗口 `m-end-B`
  attempt=2 双发；cancelling→cancelled 不复活）。
