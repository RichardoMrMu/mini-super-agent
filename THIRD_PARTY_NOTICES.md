# 第三方与上游声明（THIRD_PARTY_NOTICES）

本仓库是一个**教学原型**，用于讲解「Super Agent」事件引擎在崩溃恢复、
至少一次投递与取消语义上的最小可观察实现。它不是生产框架，不内置任何
真实模型 API Key，也不直接调用任何付费模型或 GitHub 写接口。

## 作者归属

本仓库的教学实现为**原创作品**，许可证见 `LICENSE`
（MIT，Copyright (c) 2026 mini-super-agent contributors）。
**本仓库未复制上游源码文件**；以下上游材料仅作**架构参考**与讲解对照。

## 参考来源（未复制代码）

| 项 | 值 |
| --- | --- |
| 参考项目 | deepseek-ai/dsh-superagent-prototype |
| 参考地址 | https://github.com/deepseek-ai/dsh-superagent-prototype |
| 参考 revision | `6337fc823ce20251c8de8085948165c81aaa701e` |
| 参考项目许可证 | MIT |
| 参考项目版权方 | DeepSeek Harness Team |
| 参考文章（微信公众号） | https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg |

说明：上游是 **DSH（DeepSeek Harness）的最小原型**，并非参考文章中描述的
完整工程实现。本教学仓库只借上游架构思路讲解**机制**，文章中的若干机制
（多进程租约、事件溯源、真实通道接入等）在本仓库中**未实现**，
并在 `docs/05-implementation-matrix.md` 中逐项标注「已实现 / 简化 / 未做」。

> 若后续维护者从上游复制了任何具体文件，必须在本节新增"复制文件清单"，
> 逐文件保留其原始版权声明与许可证。

## 运行时依赖说明

- 运行环境：Node.js 22（使用 `node:sqlite` 内置模块，启动时出现的
  `ExperimentalWarning` 为 Node 官方提示，教学原型中接受该警告）。
- 本教学仓库**零外部 npm 运行时依赖**：模型调用为确定性 mock，
  通道投递为内存 / 本地文件双写对照，不发起任何真实网络请求。
- 可选扩展（真实模型、真实 GitHub 集成）仅在 `docs/08-extension-interfaces.md`
  中给出接口形状，**未接通、未实现、不在 CI 中执行**。

## 商标与署名

DeepSeek、DSH 等名称归其各自所有者所有。本仓库与上游官方无任何
背书关系，仅作教学演示。
