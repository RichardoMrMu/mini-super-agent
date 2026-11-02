# 03 · 第三课：open task 的 thread 消息订阅（append / cancel）

> 阶段三配置：开 open task，普通 thread 消息订阅直通 `append` / `cancel`。
> 消费同一份 `fixtures/events.json`。

## 1. 代码入口

```powershell
node dist/cli.js run --stage 3 --events fixtures/events.json --state-dir state/demo --workers 2
```

退出码 0；trace 见 `evidence/cli-stage3.jsonl`。

## 2. 讲解

一个任务在运行期间，同 conversation 的普通 thread 消息会持续到达。
引擎对这两类消息的处理是**直通**的：

- `append`：把消息追加进任务的待消费队列，任务在模型边界之间消费它；
- `cancel`：写取消**意图**，但**不硬杀**正在跑的模型——running slot
  保留到模型边界自然退出；若任务还是 `queued`，则同事务立即终态。

三条最容易写砸的语义：

1. **被取消的任务不恢复**：cancel 提交后走向 `cancelled`；
   重启时若任务处于 `cancelling`，直接判 `cancelled`，**不复活**。
2. **finish 与 cancel 竞争**：谁先提交谁赢（first commit wins）。
   不能用内存标志判断——进程随时可能在两者之间崩溃。
3. **完结晚来新 task / finish 不丢 append**：任务完结后到达的新 task
   必须独立触发；完结时队列里未消费的 append 被 filter 掉（trace 可见），
   不静默吞。

## 3. 真实可观察输出（evidence/cli-stage3.jsonl，节录）

```
{"seq":4,"at":5,"kind":"intake","eventId":"t1:2:followup:A","result":"stored","note":"appended to A state=queued"}
{"seq":7,"at":42,"kind":"intake","eventId":"t1:3:cancel:A","result":"stored","note":"cancel intent on A state=running"}
{"seq":12,"at":58,"kind":"task.terminal","taskId":"A","outcome":"cancelled"}
{"seq":16,"at":73,"kind":"intake","eventId":"t1:50:followup:A","result":"filtered","note":"append filtered: task cancelled, already terminating"}
{"seq":17,"at":89,"kind":"intake","eventId":"t1:51:message:D","result":"stored","note":"task D queued"}
```

## 4. 失败案例

**反例 A：cancel 硬杀模型**。观察现象：模型调用中途被打断，留下悬挂 snapshot。

**反例 B：取消后幽灵恢复**。观察现象：`cancelling` 重启后任务又跑起来。

**反例 C：finish 丢未消费 append**。观察现象：队列里 append 凭空消失。

**反例 D：用内存标志判 finish/cancel 胜负**。观察现象：崩溃在两提交之间，状态歧义。

## 5. 验证 oracle 一一对应

| 观察点 | 期望 | 探针 |
| --- | --- | --- |
| queued cancel 立即终态 + 清尾 | task=cancelled、queued input 清空、reply 已写 | `CANCEL-QUEUED` |
| running cancel 只写意图 | task=cancelling | `CANCEL-RUNNING` |
| cancelling 重启 | 直接 cancelled | `BOOT-CANCELLING` |
| 完结晚到 followup | filtered，不复活 | `LATE-FOLLOWUP` |
| 完结晚到新 task | 独立触发 | `CLI-RECOVERY-CRASH-STEP`（D 独立完成） |

上一课：[`02`](02-lesson-router-workers.md) ·
下一课：[`04`](04-lesson-sqlite-recovery.md)。
