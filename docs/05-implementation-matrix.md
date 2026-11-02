# 05 · 文章机制实现矩阵

对照参考文章（[公众号原文](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)、
上游 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
revision `6337fc8…`）逐条标注：**✅ 已实现** / **🟡 简化** / **✖ 未做**。

| # | 文章机制 | 本仓库状态 | 说明 |
| --- | --- | --- | --- |
| 1 | 事件流确定性重放（同一份 fixture 分阶段消费） | ✅ | `fixtures/events.json` 逐字消费，阶段只切配置 |
| 2 | 单会话 await head-of-line 阻塞演示 | ✅ | 第一课 |
| 3 | Router + N workers 并发分发 | ✅ | 第二课；同 conv sticky 单 worker |
| 4 | inline / spill 结果标签路由 | ✅ | spill 只留引用，正文落可重建产物区 |
| 5 | open task thread 消息 append / cancel | ✅ | 第三课直通订阅 |
| 6 | cancel 仅意图、slot 保留到模型边界 | ✅ | first commit wins |
| 7 | cancelling 重启直接 cancelled | ✅ | 不复活 |
| 8 | finish 不丢未消费 append（死信/tombstone） | ✅ | 数量对账 |
| 9 | 完结后晚到新 task | ✅ | 新任务独立触发 |
| 10 | 每命令原子事务（领域 + outbox 同 tx） | ✅ | aftercommit 只唤醒 |
| 11 | 模型前 snapshot/claim，成功后 checkpoint+consumedIds+effects 同 tx | ✅ | 第四课核心窗口 |
| 12 | 崩溃后输入重读 / context 恢复 | ✅ | 双路径可注入演示 |
| 13 | channel.db 独立 messageId 去重 | ✅ | 与引擎主库分离 |
| 14 | send 成功、ack 另一 tx 的崩溃窗口 | ✅ | naive 对照双发演示 |
| 15 | 同 conv FIFO / 毒消息 3 次重试 dropped | 🟡 | 重试计数与 dropped 放行实现；真实投递网络抖动未模拟 |
| 16 | 看门狗 pid 文件 / 活 pid+EPERM 拒绝 / 死 pid stale 接管 | 🟡 | 教学路径；仅单一恢复启动器，不解决 PID 复用 |
| 17 | schema 版本未知拒绝 | ✅ | 不自动迁移 |
| 18 | doctor 外部只读 detect | ✅ | 不 kill、不改 state |
| 19 | 真实模型接入 | ✖ | 仅 mock；接口形状见 `08` |
| 20 | 真实 GitHub / 通道写入 | ✖ | 仅 mock；接口形状见 `08` |
| 21 | 多进程租约（leader election / fencing token） | ✖ | 教学单机单实例，见 `06` |
| 22 | 事件溯源（event sourcing / 不可变日志重建状态） | ✖ | 用 SQLite 状态 + outbox 代替，见 `06` |
| 23 | 并发 stale 接管 / PID 复用防护 / 网络 FS pid 语义 | ✖ | 明确不保证，见 `09` |
| 24 | 端到端 exactly-once 投递承诺 | ✖ | 明确不声明，见 `07` |
| 25 | 分布式追踪 / metrics / 告警 | ✖ | 仅 stdout + SQLite 日志表 |

> 矩阵已按最终实现复核；✅ 条目均有 `evidence/` 实测 trace 或 `tests/` 探针守护。
