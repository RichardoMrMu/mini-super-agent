# 02 · 第二课：Router + N workers 与 inline / spill 标签

> 阶段二配置：Router + N workers、确定性 mock，回复标签 `inline` / `spill`。
> 消费同一份 `fixtures/events.json`。

## 1. 代码入口

```powershell
node dist/cli.js run --stage 2 --events fixtures/events.json --state-dir state/demo --workers 2
```

退出码 0；trace 见 `evidence/cli-stage2.jsonl`。

## 2. 讲解

Router 按 conversation / task 维度把事件分发到 N 个 worker。同一个
conversation 的事件必须落在同一个 worker（同 conv FIFO，见
`docs/00-overview.md` §4），不同 conversation 可以真正并行——这样第一课
里"慢会话堵死整队"被解除：慢会话占一个 worker，其他会话照常推进。

确定性 mock 的每条回复带一个标签：

- `inline`：结果短小，直接内联进会话上下文；
- `spill`：结果超长，**不内联**，只在上下文里留一个引用（指针 / id），
  正文落到可重建产物区，需要时再按引用取回。

**错误 inline 反例**：引擎实现错误地把 `spill` 结果也按 `inline` 内联进
上下文——上下文被超长正文污染，后续模型输入体积爆炸、顺序错位，
甚至把引用当成正文再次回灌。这一课要你能从日志里**一眼看出**哪些
结果被错内联了。

## 3. 真实可观察输出（evidence/cli-stage2.jsonl，节录）

```
{"seq":5,"at":33,"kind":"task.boot","taskId":"A","resumedFrom":0,"recovery":false}
{"seq":6,"at":33,"kind":"task.boot","taskId":"B","resumedFrom":0,"recovery":false}
```

A 与 B 在同一时刻（at=33）并行启动——对比阶段一 B 要等 A 完成后才被
intake。同 conversation 事件保持单 worker 顺序。

## 4. 失败案例

**反例 A（本课主角）**：spill 被当 inline 内联。
观察现象：后续模型输入体积异常大、上下文里出现 spill 正文全文。

**反例 B**：同 conv 事件被分到两个 worker。
观察现象：同一 conversation 的两条消息出现乱序完成。

**反例 C**：router 随机分发但 worker 间共享状态。
观察现象：并行总耗时不降反升（锁竞争），与第一课无差别。

## 5. 验证 oracle 一一对应

| 观察点 | 期望 | 探针 |
| --- | --- | --- |
| spill 正文不进后续模型输入 | 输入中只含引用 id | schema/task 字段契约（`TASK-COUPLE`） |
| 同 conv 单 worker | 路由表无跨 worker | stage2 trace 时序 |
| 并行加速 | A/B 同时 boot | `CLI-STAGE1` vs `cli-stage2.jsonl` 对比 |

上一课：[`01`](01-lesson-single-session-await.md) ·
下一课：[`03`](03-lesson-open-task-thread.md)。
