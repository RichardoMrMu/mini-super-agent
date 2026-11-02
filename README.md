# mini-super-agent（中文教学仓库）

一个**最小可观察**的 Super Agent 事件引擎教学原型。它用同一份
`fixtures/events.json`，分四步把「单会话阻塞 → 路由多 worker → 开放任务
线程消息 → SQLite 崩溃恢复」串起来，让你能**亲手看到**崩溃、取消、
重投、去重这些机制到底在什么时刻、哪一行提交边界上生效。

> 这是教学仓库，不是生产框架：零 API Key、零外部运行时依赖、模型为
> 确定性 mock。真实模型与真实 GitHub 集成仅在
> [`docs/08-extension-interfaces.md`](docs/08-extension-interfaces.md) 给出
> 接口形状，**未接通**。

## 它在讲什么

参考文章描述了一个多会话、可恢复、可取消的 Agent 运行时。本仓库把其中
最容易"以为懂了、实际一崩溃就穿"的四条不变量抽出来，做成四个渐进阶段：

| 阶段 | 演示什么 | 你会看到的失败 |
| --- | --- | --- |
| 1 | 单会话 `await` 导致后续事件 head-of-line 延迟 | 一个慢会话堵死整队 |
| 2 | Router + N workers；确定性 mock 标签 `inline` / `spill` | 错误地把 spill 当 inline 消费 |
| 3 | open task 普通 thread 消息订阅：直通 append / cancel；被取消不恢复；完结后晚来新 task | 取消后幽灵恢复、完结后丢消息 |
| 4 | SQLite 持久化与重启恢复 | 崩溃在"模型成功但未提交"窗口 |

四阶段**逐字消费同一份 `fixtures/events.json`**，阶段之间不改 fixture，
只改引擎配置（worker 数、是否开 outbox 去重、是否开持久化）。

## 目录结构

```
mini-super-agent/
├── README.md                  ← 本文件
├── LICENSE                    ← MIT（本仓 contributors）
├── THIRD_PARTY_NOTICES.md     ← 上游署名与 revision
├── docs/
│   ├── 00-overview.md             ← 架构与冻结合同（先读这篇）
│   ├── 01-lesson-single-session-await.md
│   ├── 02-lesson-router-workers.md
│   ├── 03-lesson-open-task-thread.md
│   ├── 04-lesson-sqlite-recovery.md
│   ├── 05-implementation-matrix.md    ← 文章机制：实现/简化/未做
│   ├── 06-tradeoffs.md                 ← 技术取舍
│   ├── 07-exactly-once-counterexamples.md ← 恢复与外部 exactly-once 反例
│   ├── 08-extension-interfaces.md    ← 可选模型/GitHub 扩展接口
│   └── 09-limitations-and-coverage.md ← 局限与测试覆盖
└── tests/
    └── PLAN.md                ← 黑盒探针计划（契约→反例→oracle）
```

> `src/`、`fixtures/`、`package.json` 是生产实现；文档与独立复核测试
> 不修改它们，只通过**公开入口（CLI / 导出函数）**黑盒观察。

## 环境要求

- Node.js 22（使用内置 `node:sqlite`；启动时的 `ExperimentalWarning`
  是 Node 官方提示，教学原型接受，见 `docs/09-limitations-and-coverage.md`）。
- 不要求任何 API Key、不要求联网、不要求全局 npm 包。

## 快速开始

```powershell
npm install                 # 仅 devDependencies（typescript），无运行时依赖
npm run build               # tsc → dist/
node dist/cli.js run --stage 1 --events fixtures/events.json --state-dir state/demo --workers 2
node dist/cli.js recovery --scenario crash-step --state-dir state/recovery
node dist/cli.js recovery --scenario crash-send --state-dir state/recovery
node dist/cli.js recovery --scenario crash-claim --state-dir state/recovery
node dist/cli.js doctor --state-dir state/demo
npm test                    # build + node --test tests/*.test.mjs（37/37）
```

四阶段同一份 `fixtures/events.json` 逐字消费，仅切开关：
`stage 1` 串行内联基线；`stage 2` worker 池；`stage 3` + thread 直通；
`stage 4` + 文件 `engine.db` 与 boot 恢复。实测 trace 在
[`evidence/`](evidence/)（`cli-stage1..4.jsonl`、`stage4-dedup.jsonl`、
`recovery-step.txt`、`recovery-send.txt`）。

崩溃注入（教学用）：`MOCK_CRASH_AT_STEP=<taskId>:<stepN>` 在 step 开始时
`exit 13`；`MOCK_CRASH_AFTER_SEND=1` 在通道 send 后、engine ack 前
`exit 13`；`MOCK_CRASH_AFTER_CLAIM=<taskId>:<stepN>` 在本步 tx#1（只读
snapshot）提交后、tx#2 checkpoint 前 `exit 13`——pending input 崩溃重读。

## 推荐阅读顺序

1. `docs/00-overview.md` —— 冻结合同全文，所有不变量的唯一权威来源。
2. `docs/01` → `docs/04` —— 四课，每课结构固定：
   **代码入口 → 讲解 → 真实可观察输出 → 失败案例 → 验证 oracle**。
3. `docs/05` → `docs/09` —— 矩阵、取舍、反例、扩展、局限。
4. `tests/PLAN.md` —— 每个探针对应的「唯一错误实现」与红绿判定。

## 核心不变量（一句话速记）

- **每命令一个原子事务**：领域状态、`effects/outbox` 同事务提交；
  `aftercommit` 只负责唤醒，不在事务里干活。
- **模型边界**：调用前 snapshot/claim 输入；成功后 step checkpoint、
  `consumedIds`、effects 同事务提交。崩溃在两者之间 → 输入重读；
  已提交 → context 恢复。
- **cancel 分两种落点**：queued 任务同 tx 立即 cancelled（杀 assignment、
  filter input、写 reply）；running 任务只写 `cancelling` 意图，slot 保留到
  模型边界；finish/cancel 先提交者胜；cancelling 崩溃重启直接 cancelled。
- **投递不承诺端到端 exactly-once**：`channel.db` 按 messageId 独立去重，
  engine ack 在另一事务；"真实 send 成功但 ack 前崩溃"是必然窗口，
  naive 不去重对照会双发。
- **同 conv FIFO / head-of-line**：毒消息重试 3 次后 dropped 放行，不堵全队。
- **看门狗只教学**：活 pid / EPERM 拒绝启动；死 pid 视为 stale，由单一
  恢复启动器接管；不承诺并发 stale 接管、PID 复用、网络文件系统。
- **schema 未知即拒绝**；`doctor` 外部只读 detect，不 kill、不改 state。

## 测试

黑盒测试通过 Node 原生 `node --test` 跑公开入口，不引第三方 runner。
`package.json` 已约定：`npm test` = `npm run build && node --test tests/*.test.mjs`
（当前 37/37 通过）。最高风险探针的红绿变异**一律在仓库外临时副本**上做，
不改动 `src/`。探针清单与判定 oracle 见 [`tests/PLAN.md`](tests/PLAN.md)。

## 许可

MIT，见 [`LICENSE`](LICENSE) 与 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
