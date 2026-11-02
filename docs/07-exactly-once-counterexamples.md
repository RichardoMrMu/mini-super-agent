# 07 · 恢复与外部 exactly-once 反例

本文是全仓库**最重要的一课反面教材**：用两个对照实现，亲手看到
"你以为不会发生"的双发到底发生在哪一行。

## 反例 1：send 成功、ack 前崩溃 = 必发双份

时序（outbox 模式的标准形状）：

```
时刻 t1: outbox 插入一条待发消息 (status=pending)，同事务提交
时刻 t2: 真实 send 成功（外部已收到）          ← 副作用已发生
时刻 t3: ack 事务把 status 改成 sent            ← 另一事务
时刻 t4: 若崩溃在 t2 与 t3 之间…
```

重启后恢复逻辑看到 outbox 里 `status=pending`，**重发**。外部系统于是
收到**两条**。这不是 bug，这是 outbox 模式的固有窗口。

- **本仓库对照**：
  - naive 实现（不去重）→ 窗口内崩溃重发，下游收到 **2 条**（双发演示）；
  - `channel.db` messageId 去重实现 → 第二次 send 在通道侧被压成 **1 条**。
- **结论**：`channel.db` 去重让**通道侧**不重复投递；但如果外部系统在
  t2 已经产生了真实副作用（例如真的发了一封邮件），去重表**拦不住那封
  邮件**。所以端到端不能声明 exactly-once，只能要求**下游幂等**。

对应探针：`P-DEDUP-NAIVE`（双发）、`P-DEDUP-SUPPRESS`（去重后一条）。

## 反例 2：step 开头崩溃（已有前序 checkpoint）= 本步重跑，前序不重放

```
T1: snapshot/claim 本步输入（已提交；前序 step checkpoint 已落库）
─── step 开始处注入崩溃（MOCK_CRASH_AT_STEP，exit 13）───
T2: checkpoint + consumedIds + effects（本步尚未到达）
```

重启后 boot 恢复把任务置回 `queued`（**保持 stepsDone 与已提交 checkpoint**），
直接插入新 assignment；本步 pending input 仍在 `queued` 集合 → **重读并重跑
本步模型**，前序 checkpoint 不重放。

> 教学要点：本步的 tx#1 snapshot 是**内存只读读取**，不落任何"claim 行"；
> 崩溃后能恢复的只有已提交的前序 checkpoint。所以 pending input 整体重读、
> 由 tx#2 一次性 checkpoint + consumedIds 落库。

本仓库实测（`recovery --scenario crash-claim`，fixture
`recovery-checkpoint.json`）：首跑 stepsDone=1、input queued、仅 step1 完成、
`exit=13`；二跑 `resumedFrom=1`、step2 同一 input 全程只消耗一次、
通道侧仅 1 条 reply。对应探针 `CLI-RECOVERY-CLAIM`。

## 反例 3：用内存标志判 finish/cancel 胜负

- 错误写法：`if (memoryCancelled) status = 'cancelled'`。
- 崩溃在"finish 已提交、cancel 已写入意图"之间 → 重启后内存标志没了，
  胜负无从判断。
- 正确写法：胜负看**哪个事务先提交落库**，状态机从数据库恢复。

对应探针：`P-CANCEL-RACE`。

## 反例 4：毒消息无限重试堵死 FIFO

- 错误写法：失败无限重试过这条消息。
- 结果：同 conversation 后续消息全被 head-of-line 堵住。
- 正确写法：连续 3 次失败 → dropped 进死信队列，**放行**后续消息。

对应探针：`P-POISON-DROP`。

## 反例 5：活 pid / EPERM 误放行，或死 pid 不敢接管

- **错误写法 A**：pid 文件存在就认为实例活着，直接退出或直接覆盖。
  - 若 pid 其实已死 → 新实例不敢接管，服务僵死；
  - 若 pid 活着（甚至是别的用户、EPERM）→ 新实例强写 LOCK，双实例
    写同一个 SQLite。
- **本仓库教学立场（`src/lock.ts`）**：
  - pid 存活（含 EPERM，即"存在但无权信号"）→ `refused-live-pid`，拒绝启动；
  - pid 已死 → 视为 stale，**由单一恢复启动器接管**，覆盖 LOCK。
- **不解决**：PID 复用（旧 pid 死了，操作系统把同号分给无关进程，
  `pidAlive` 会误判为活）与并发 stale 接管——见 `09`。

对应探针：`P-WX-LIVEPID`、`P-WX-DEADPID-TAKEOVER`。

## 一句话总结

> **事务内能原子保证的，只有"状态 + outbox 记录"同生共死；
> 事务外的真实世界，永远只能靠下游幂等兜底。**
