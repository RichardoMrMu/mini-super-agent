# 01 · 第一课：单会话 await 的 head-of-line 延迟

> 阶段一配置：单 worker、无 outbox、无持久化。
> 消费同一份 `fixtures/events.json`。

## 1. 代码入口

```powershell
node dist/cli.js run --stage 1 --events fixtures/events.json --state-dir state/demo --workers 1
```

退出码 0；trace 写在 `--out` 指定的 jsonl（见 `evidence/cli-stage1.jsonl`）。

## 2. 讲解

阶段一的引擎最简单：一个 worker 按事件流顺序处理，每条输入事件触发一次
`await`（这里是确定性 mock 的延迟 await，不是真实网络）。

fixture 里同一个 conversation（或相邻事件序列）包含：

1. 一个**慢会话事件**：它的 mock `await` 时间被确定性地拉长；
2. 紧随其后的**若干快事件**。

在单 worker 顺序模型下，慢会话的 `await` 不返回，后面的事件**一个都轮
不到**。这就是 head-of-line blocking：队首一条慢消息，堵住整条队。

这一课的目的不是教你"并发好"，而是让你**先看到没有并发时的坏味道**：
阶段二 Router + N workers 正是为了解除这个阻塞，但解除方式本身会带来
新问题（见第二课的 inline/spill 标签）。

## 3. 真实可观察输出（evidence/cli-stage1.jsonl，节录）

```
{"seq":2,"at":2,"kind":"intake","eventId":"t1:0:message:A","result":"stored"}
{"seq":6,"at":69,"kind":"task.terminal","taskId":"A","outcome":"completed"}
{"seq":8,"at":74,"kind":"intake","eventId":"t2:1:message:B","result":"stored"}
```

**期望 oracle**：B 的 intake（at=74）严格晚于 A 完成（at=69）——
B 事件在 at=1 就进入事件流，却被排在 A 的 await 后面。
不存在"快事件先于慢会话完成"的记录。

## 4. 失败案例（故意做错）

**反例 A：把 await 换成立即返回**（错误实现）。
看起来"变快了"，但模型结果根本没回来就推进了状态——这是假装并发。

**反例 B：起了 N 个 worker 但共享一个锁**（错误实现）。
表面并发，实际所有 worker 在同一把锁上排队，退化成顺序执行，与阶段一
无差别。

## 5. 验证 oracle 一一对应

| 观察点 | 期望 | 探针 |
| --- | --- | --- |
| 慢会话后快事件的 intake 时序 | 严格不早于慢会话完成 | `CLI-STAGE1` trace + stage1 vs stage2 对比 |
| 无并发时的总耗时 | ≈ 各事件耗时之和 | stage1 trace at 时间戳 |
| 慢事件结果未回时不得推进后续会话状态 | 后续 intake 时间 > 慢事件结束 | `CLI-STAGE1` |

下一课：[`02-lesson-router-workers.md`](02-lesson-router-workers.md)。
