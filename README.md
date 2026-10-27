# shx-tools

内部自动化工具箱：一个可扩展的 Windows 桌面容器，把重复的文件收集劳动收敛为「选工具 → 填参数 → 跑任务 → 看结果」。首版交付 **F1 图片批量收集**。

> 当前状态：设计文档完成；**M0 任务骨架已落地**——假工具能跑通「扫描 → 明细落盘 → 暂停 → 继续 → 复制 → 报告」。
> 还差最后一步验收：NSIS 安装包装到干净的 Windows 机器上跑通假任务（本机是 macOS，见文末）。

## 快速开始

包管理器统一用 **pnpm**（`packageManager` 锁定版本，建议先 `corepack enable`）；依赖只认 `pnpm-lock.yaml`，不要用 npm / yarn 重新生成锁文件。需要 Node.js ≥ 22.12。

```bash
pnpm install     # 安装依赖（首次按 pnpm-workspace.yaml 的 allowBuilds 放行安装脚本）
pnpm dev         # 开发态：Electron 窗口 + HMR
pnpm test        # 单元测试（Vitest）
pnpm lint        # ESLint，含渲染进程 / 工具的依赖边界规则
pnpm build       # typecheck + main / preload / worker / renderer 构建
pnpm smoke       # 无窗口跑通整条任务链路，退出码即结果
```

在受限环境（CI、无桌面会话、沙箱）里 Electron 起不来时，追加 Chromium 开关：

```bash
pnpm smoke -- --no-sandbox --disable-gpu
```

## M0 现在有什么

| 模块 | 落点 | 状态 |
|---|---|---|
| 任务状态机 | `electron/core/task/task-state.ts` | 八态、合法迁移表、纯函数可单测 |
| 任务编排 | `electron/core/task/task-manager.ts` | 创建 / 暂停 / 继续 / 取消 / 删除、全局与单工具并发闸门、状态单点写 |
| 持久化 | `electron/core/task/task-store.ts` | 一任务一 JSON、明细 JSONL、原子写、损坏改名、按 kind 保留 200 条 |
| worker | `electron/core/worker/worker-host.ts` + `electron/worker/entry.ts` | fork / kill、心跳 15 秒判死、进度节流、明细批量 + `resend` |
| 契约 | `shared/tool-contract.ts`、`shared/worker-protocol.ts` | `ToolExecutor`、`TaskRecord`、主进程 ↔ worker 消息 |
| 假工具 | `tools/fake/` | scan / copy 两个 kind，支持续传 |
| 界面 | `src/` | 侧栏 + 工具页（参数 / 进度 / 暂停继续取消）+ 任务中心 |

**已经验证过的**：假工具扫描 30 个目录，暂停时 15 条明细已落盘，继续后总数仍是 30（无重复）；复制任务读源清单、产出报告；`typecheck` / `lint` / 7 个单测 / 三端构建全绿。

## 仓库结构

```
electron/            主进程、preload、worker（Node 侧）
  main.ts            入口：单实例、初始化、IPC 注册与广播、生产 CSP
  app/               窗口、冒烟脚本
  core/task/         task-state / task-manager / task-store
  core/worker/       worker-host（跨环境路径、心跳、kill）
  core/storage/      config.json、原子写
  ipc/               通道注册（zod 校验入参）
  worker/entry.ts    utilityProcess 入口
  preload/           contextBridge 白名单 + 渲染进程类型
shared/              三端共享契约（不依赖 electron）
infra/               与业务无关的基础设施（并发信号量）
tools/               静态注册表 + fake 工具
src/                 渲染进程（React 19 + antd 6）
tests/unit/          纯函数单测
tests/fixtures/lnk/  F1 .lnk 解析用的真实样本（力禧特 8 个）
build/               应用图标
docs/                五份设计文档，按「需求 / 架构 / 功能 / UI / 发布」分层，入口 docs/README.md
```

## 与设计文档的偏差（M0 期间产生，待回写）

实现时发现契约有几处缺口，先按最小改动补上，M1 前应回写进《架构》第 6、8 章：

| 位置 | 偏差 | 原因 |
|---|---|---|
| `ToolContext` | 增加 `taskId`、`tempDir`（任务目录）、`sourceTaskDir`、`resumeFrom` | 原文只说「worker 读日志算出已完成集」，没规定怎么把结果交给执行器 |
| `CopyCommand` | 增加 `sourceScanId`、`resumeFrom` | 复制任务必须能定位源扫描；续传起点由主进程按上次进度传入 |
| `electron-builder.yml` | `asarUnpack` 同时解包 `out/main/chunks/**` | worker 与 main 共享的错误码 chunk 会被 Rollup 拆出去，只解包 `worker.js` 不够 |

## 文档

全部设计文档集中在 [`docs/`](docs/README.md)，从 [文档索引](docs/README.md) 进入（版本号以索引为准），按「需求 → 架构 → 功能 → UI → 发布」阅读。

| 层 | 文档 | 内容 |
|---|---|---|
| 需求 | [需求与方案设计](docs/01-需求/shx-tools-需求与方案设计.md) | 产品定位、平台能力、关键方案、排期、风险、决策记录 |
| 架构 | [架构设计与技术栈](docs/02-架构/shx-tools-架构设计与技术栈.md) | 进程模型、工具契约、状态机、IPC、存储、错误模型、并发、目录规划、M0 |
| 功能 | [F1 图片收集设计](docs/03-功能/shx-tools-F1-图片收集.md) | 端到端流程、入口与路径模板、扫描 / 复制两任务、暂停与续传、前缀预检、`.lnk` 解析、持久化、验收 |
| UI | [UI 设计规范](docs/04-设计/shx-tools-UI设计规范.md) | 信息架构、页面规格、状态矩阵、设计令牌、文案、验收清单 |
| 发布 | [打包、分发与自动更新](docs/05-发布/shx-tools-发布与更新设计.md) | 发布产物、更新源配置、降级路径、NSIS / ZIP 两套时序、更新异常矩阵 |

**阅读顺序**：需求 → 架构 → 功能 → UI →（M3 再读）发布。决策以需求第 8 节为准；细节冲突时以独立文档为准；**同一个决策只在一份文档里写全文**，其它文档只留编号。新增或移动文档时，按 [docs/README.md](docs/README.md) 的约定更新索引。

## 下一步

1. **M0 收尾（Windows）**：`pnpm build:win` → 装到干净机器 → 跑假任务 → 看报告；顺带确认 asar 解包后的 worker 能 fork。
2. **M1**：`.lnk` 解析、路径模板、笛卡尔积扫描、前缀预检、真实复制与报告。
3. 契约偏差回写文档，避免 M1 按旧契约实现。
