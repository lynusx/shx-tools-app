# shx-tools 架构设计与技术栈

> 版本：v0.2 ｜ 日期：2026-10-24
> 上游文档：《shx-tools 需求与方案设计（总览）》
> 关联文档：《shx-tools F1 图片收集设计》

---

## 0. 本文范围

本文覆盖三部分：

1. **应用架构**（第 1~12 章）：进程模型、分层与依赖规则、模块划分、任务数据流、工具契约、状态机、通信协议、本地存储、错误模型、并发控制
2. **技术栈与工程结构**（第 13~14 章）：选型及理由、目录规划、构建与打包配置、编码约定、测试策略、质量门禁
3. **项目初始化**（第 15 章）：脚手架选择、改造清单、M0 验收标准

不包含：具体业务功能的设计。F1 见《shx-tools F1 图片收集设计》。

---

## 1. 设计原则

| 原则 | 具体含义 | 反面案例 |
|---|---|---|
| **状态单点写** | 任务状态只由主进程 `TaskManager` 修改，worker 只上报事实 | worker 自己改状态，导致 UI 与磁盘记录不一致 |
| **边界不穿越** | UI 不碰文件系统，worker 不碰窗口与 IPC，main 只做编排 | 渲染进程直接 `require('fs')`，安全边界失效 |
| **崩溃隔离** | 任一工具进程异常不影响应用本体与其他任务 | 在 main 里跑耗时遍历或重任务，一次 OOM 直接退出 |
| **过程可复现** | 每个任务留存参数快照、日志、结果，凭 taskId 可还原现场 | 只记"成功 4123 个"，出问题无从追查 |

## 2. 进程模型

```
┌─────────────────────────────────────────────────────────┐
│ Main Process (Node)                                     │
│  窗口管理 · 菜单 · 单实例锁 · 更新 · 任务调度 · IPC 路由  │
└───────────┬───────────────────────────┬─────────────────┘
            │ IPC (invoke / event)      │ utilityProcess.fork
┌───────────▼──────────────┐  ┌─────────▼──────────────────┐
│ Renderer (React + antd)  │  │ Worker (Node, 无 UI)        │
│  路由 · 表单 · 进度 · 日志 │  │  工具执行器 · 扫描 · 聚合    │
│  无 Node 权限             │  │  独立崩溃域 · 可 kill       │
└──────────────────────────┘  └────────────────────────────┘
            ▲
            │ contextBridge（白名单 API）
        Preload (sandboxed)
```

**进程生命周期**

| 进程 | 创建时机 | 销毁时机 | 数量 |
|---|---|---|---|
| Main | 应用启动 | 应用退出 | 1 |
| Renderer | 主窗口创建 | 窗口关闭 | 1（本期不用多窗口） |
| Worker | 每次任务开始时 fork | 任务终态后 5 秒回收；取消时立即 kill | 最多 2（与全局并发上限一致） |

**为什么用 `utilityProcess` 而不是 `worker_threads`**

- 独立进程，工具里出现未捕获异常或内存爆掉不会带崩主进程
- 可被主进程直接 `kill()`，取消任务干净彻底
- 支持 `stdio` 管道收集日志，排查线上问题方便
- 代价：进程间通信有序列化开销，因此进度事件在 worker 侧就节流（见第 8 章）

> 注意：`utilityProcess.fork()` 需要磁盘上真实存在的 JS 文件，**不能从 asar 包内直接 fork**。打包时必须把 worker 产物解包到 `app.asar.unpacked`，详见 14.5。

## 3. 分层与依赖规则

```
      ┌──────────────────────────────┐
      │  src（React UI）              │
      └───────────┬──────────────────┘
                  │ 只能通过 window.shx
      ┌───────────▼──────────────────┐
      │  preload（contextBridge）     │
      └───────────┬──────────────────┘
                  │ IPC
      ┌───────────▼──────────────────┐        ┌─────────────────┐
      │  electron/core + ipc（编排）  │───────▶│ worker/entry.ts │
      └───────────┬──────────────────┘        └────────┬────────┘
                  │                                     │
      ┌───────────▼─────────────────────────────────────▼────────┐
      │  tools（业务实现）                                        │
      └───────────┬──────────────────────────────────────────────┘
                  │
      ┌───────────▼──────────────┐
      │  infra（fs / 并发 / lnk） │
      └───────────┬──────────────┘
                  │
      ┌───────────▼──────────────┐
      │  shared（类型与常量）      │
      └──────────────────────────┘
```

| 层 | 可以依赖 | 明令禁止 |
|---|---|---|
| `shared` | 仅第三方纯类型库（zod） | 依赖任何上层、引入 Node API |
| `infra` | `shared`、Node 内置、第三方库 | 依赖 `tools`、`core`、业务概念（不能出现具体业务字样） |
| `tools` | `shared`、`infra` | 依赖 `core`、`ipc`、`electron` |
| `worker` | `tools`、`infra`、`shared` | 依赖 `electron` 的 UI 模块 |
| `core`（main） | `shared`、`infra` | 直接调用具体工具的业务函数（必须经 worker） |
| `ipc` | `core`、`shared` | 写业务逻辑 |
| `preload` | `shared` 类型、`electron` 的 `contextBridge` | 暴露 `ipcRenderer` 本身 |
| `src` | `shared` 类型、`window.shx` | `import electron`、`import fs`、直接 import `tools/*` |

**强制手段**：ESLint `no-restricted-imports` 按目录配置禁用规则。这条不能只写在文档里——没有 lint 拦截，三个月后依赖必然乱。

## 4. 模块划分

| 模块 | 进程 | 职责 | 对外接口 | 依赖 |
|---|---|---|---|---|
| `app-shell` | main | 单实例、窗口、菜单、生命周期兜底 | `createMainWindow()` | core |
| `ipc-router` | main | 注册通道、zod 校验、错误包装为标准响应 | `registerChannels()` | core、shared |
| `task-manager` | main | 两类任务的创建、状态机、并发闸门、持久化 | `create(kind)/cancel/get/list/latestScan` | task-store、worker-host |
| `worker-host` | main | fork/kill worker、消息编解码、心跳、超时 | `exec(taskId, msg)` | protocol |
| `tool-registry` | main+worker | 工具清单与执行器映射 | `list()` / `getExecutor(id)` | tools |
| `storage` | main | 配置、模板、任务记录读写，原子写与损坏恢复 | `load/save/patch` | atomic-write |
| `logger` | main+worker | 分级日志、按天滚动、路径脱敏 | `info/warn/error/child(tag)` | — |
| `updater` | main | 源解析、检查、下载、校验、安装 | `check/download/install` | feed、storage |
| `feed-client` | main | UNC / HTTPS 清单探测与读取 | `probe()` / `read()` | — |
| `local-proxy` | main | 把 UNC 目录映射为 127.0.0.1 静态服务 | `start(root)` / `stop()` | — |
| `lnk-resolver` | worker | 解析 `.lnk` 二进制，取 UNC 目标 | `resolveBatch(paths)` | shared |
| `path-template` | worker | 按产品模板渲染完整路径 | `render(tpl, combo)` | shared |
| `cartesian-expander` | worker | 字段集合笛卡尔积展开（惰性） | `expand(params) → Iterable<ScanUnit>` | path-template |
| `scanner` | worker | 逐目录扫描、状态归类、收集 | `scanOne(unit, ctx)` | infra/fs、copier |
| `copier` | worker | 复制、冲突处理、去重、进度上报 | `copyAll(items, ctx)` | infra/fs |
| `schema-form` | renderer | JSON Schema → antd 表单 | `<SchemaForm />` | antd |
| `task-store`(ui) | renderer | 任务列表与实时进度的前端状态 | zustand store | — |

## 5. 一次完整作业的数据流（以 F1 为例）

一次"收图"由**两次任务**组成：先扫描，看结果，再复制。

```
⓪ 选入口       UI → entry:scan(path) → main 判定入口形态
                形态 A（一级下存在 .lnk）：一级 = 区域 → 解析 lnk 得机台根
                                            → 力禧特再探测 {subDir}
                形态 B（无 .lnk，一级目录匹配 ^[AB]\d{2}-）：一级 = 机台
                                            → 机台根 = 入口 + 目录名
                                            → 区域由首字母推导（A 东 / B 西）
                → 返回 { entry, machines } → 写入 categories.json 对应产品分组
                （轻操作，不进任务队列，不占任务记录）

── 扫描任务 ──────────────────────────────────────────────
① 填扫描参数    UI 勾机台，填日期 / 班次 / 时段 / 不良类型 / 扩展名
② 点「开始扫描」 UI → task:create({ kind:'scan', params }) → main
③ 校验 + 入队   main: zod 校验 → 创建任务(preparing) → fork worker
④ 展开 + 扫描   worker: 渲染完整路径 → 笛卡尔积 → 逐个 scanOne
                → 边扫边经 ctx.appendDir / appendFile 回传
                → 上报 phase=scanning 的目录进度
⑤ 终态         worker 返回 ScanResult → main 落盘 tasks/<scanId>.{json,dirs.jsonl,files.jsonl}
                → 推 task:state(succeeded)

── 用户看结果（不是任务）─────────────────────────────────
⑥ 看清单       UI 读 task:dirs 展示 180 个目录 → 汇总"3,240 个文件 · 8.2 GB"
                觉得不值当就到此为止，或改参数重扫

── 复制任务 ──────────────────────────────────────────────
⑦ 填复制参数    目标目录 / 输出结构 / 同名冲突 / 移动 / 去重
⑧ 点「开始复制」 UI → task:create({ kind:'copy', params:{ scanId, ... } }) → main
⑨ 预检         main: 校验 scanId 有效、files.jsonl 还在、目标可写、空间 ≥ 总量 × 1.05
                → 建 CopyPlan → preparing 结束转 running
⑩ 复制         worker: 按 CopyPlan 建目录 → 逐文件复制
                → 上报 phase=copying 的文件进度与字节进度
⑪ 终态         worker 返回 ToolResult → main 落盘 → 推 task:state
⑫ 查看结果     UI 展示失败清单与汇总 → 「打开目录」/「导出 CSV」
```

**为什么 ⓪ 不放进任务模型**：任务模型带进度条、日志、运行记录和报告，是为"跑几分钟的重活"设计的。枚举 50 个机台只需约 1 秒，套进去反而增加噪音——任务列表里会堆满"扫描机台"的无意义记录。它走独立的 `entry:scan` 通道，前端用 loading 态，10 秒超时。

**为什么 ⑥ 是"看结果"而不是任务**：看完清单决定不复制，是正常收尾，不该在任务记录里留下一条"已取消"。扫描任务到此就 `succeeded` 了——它确实成功了，只是没人去消费它的产物。

**`listOnly` 模式已取消**：原来它是复制任务的一个参数，现在"只扫描不复制"就是"只建扫描任务"——不需要一个参数，也不需要一次"成功但没有副作用"的复制任务。

## 6. 工具契约

工具是"一个目录 + 三件套"，框架通过注册表发现它。**任务分两类**：`scan`（只读，产出清单）与 `copy`（写盘，消费清单）：

```ts
// shared/tool-contract.ts
export type TaskKind = 'scan' | 'copy';

export interface ToolManifest {
  id: string;                    // 'image-collector'
  name: string;                  // '图片收集'
  version: string;
  description: string;
  category: 'file' | 'network' | 'utility';
  kinds: TaskKind[];             // F1 = ['scan', 'copy']；只有一种的工具写一个
  paramsSchema: Partial<Record<TaskKind, JSONSchema>>;  // 每个 kind 一份入参 schema
  ui?: 'auto' | 'custom';        // custom = 渲染进程内的专用表单（src/pages/tool/custom/）
  icon?: string;                 // 侧栏图标（@ant-design/icons 名称）；缺省用默认图标
}

export interface ToolContext {
  report(p: { done: number; total: number; phase: TaskPhase; message?: string; metrics?: Record<string, number|string> }): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: unknown): void;
  signal: AbortSignal;           // 取消信号，执行器必须定期检查
  tempDir: string;
  /** 仅 scan 任务可用：逐条追加明细，由主进程批量落盘（不回到内存、不走 IPC 单条往返） */
  appendDir(rec: DirRecord): void;
  appendFile(rec: FileRecord): void;
}

export interface ToolExecutor<P = unknown> {
  /** 扫描：只读，绝不写目标盘。产出可被 copy 任务引用的清单 */
  scan?(params: P, ctx: ToolContext): Promise<ScanResult>;
  /** 复制/执行：写盘，必需 scanId 指向一份已完成的扫描 */
  copy?(params: P, ctx: ToolContext): Promise<ToolResult>;
}

export interface DirRecord {
  path: string;                  // 相对入口的目录路径
  status: 'ok' | 'empty' | 'missing' | 'unreachable' | 'denied' | 'error';
  files: number;
  bytes: number;
  elapsedMs: number;
  code?: string;                 // 状态对应的 TaskError.code
}

export interface FileRecord {
  src: string;
  dest: string;                  // 扫描阶段就定好的目标相对路径
  bytes: number;
  hash?: string;                 // 开启内容去重时才计算
}

export interface ScanResult {
  summary: {
    dirs: number;
    files: number;
    totalBytes: number;
    byStatus: Record<DirRecord['status'], number>;
  };
  /** 明细不在这里——边扫边经 ctx.appendDir/appendFile 落盘 */
}

export interface ToolResult {
  summary: Record<string, number | string>;
  artifacts?: { label: string; path: string }[];
  failures?: { target: string; reason: string; code?: string }[];
}
```

**为什么把 `scan` 和 `copy` 拆成两个任务而不是一个任务的两个阶段**：

| 理由 | 具体表现 |
|---|---|
| 两者副作用不同 | 扫描只读（可随便重跑），复制写盘（移动模式还删源）。放在一个任务里，取消语义要写两套，记录也说不清"这次到底动没动文件" |
| 清单是资产，不是中间态 | 扫一次可以复制多次（换目标目录、换冲突策略），也可以只看不复制。清单落盘后成为被引用的对象 |
| 失败归因不同 | 扫描失败是"机台连不上"，复制失败是"文件被占用"。混在一条记录里，失败清单只能靠猜 |
| 耗时统计对不上 | 扫描 40 秒 + 复制 4 分钟记成一条 `4m40s`，用户看不出哪一半慢 |
| `listOnly` 模式自然消失 | 原来"仅生成清单"是复制任务的一个参数，现在它就是"只跑扫描，不建复制任务" |

> `preview` / `requiresConfirm` / `awaiting_confirm` 三个概念随之删除——"先看清单再决定要不要动手"这件事，现在由 `scan → 看完 → copy` 天然承担，不需要在单个任务里塞一个确认态。将来做批量删除类工具，也是这个形状：scan 列清单，copy（删除）执行。

注册方式：`tools/index.ts` 静态导入并注册，构建期打包进 worker。**不做运行时动态加载**——内部工具数量有限，静态注册换来类型安全、打包简单、无沙箱逃逸风险。

## 7. 任务状态机

```
扫描任务：created ──▶ preparing ──────────────▶ succeeded
                          └──▶ failed / canceled

复制任务：created ──▶ preparing ──▶ running ──▶ succeeded
                          └───────────┴──▶ failed / canceled
```

两类任务**共用同一台状态机**，区别只在终止边：扫描没有"执行"阶段，`preparing` 干完就是 `succeeded`；复制的 `preparing` 是目标预检，之后进 `running` 真正写盘。

| 当前状态 | 事件 | 目标状态 | 适用 | 副作用 |
|---|---|---|---|---|
| created | `start` | preparing | scan / copy | fork worker，记录 `startedAt`、`kind` |
| preparing | `done` | succeeded | **仅 scan** | 写 `ScanResult` 汇总，明细已落盘，任务到此为止 |
| preparing | `prepareDone` | running | **仅 copy** | 载入扫描清单、目标预检通过（可写、空间够），进入复制 |
| preparing | `prepareError` | failed | scan / copy | 记录错误码与消息 |
| running | `done` | succeeded | copy | 写 `ToolResult`，生成报告 |
| running | `error` | failed | copy | 写错误栈与失败清单，保留已完成计数 |
| running | worker 非零退出 | failed | copy | 标记 `E_WORKER_CRASH` |
| preparing / running | `cancel` | canceled | scan / copy | kill worker，保留已完成部分 |
| 任意非终态 | 应用退出 | interrupted | scan / copy | 下次启动扫描残留，标记为中断 |

终态不可逆。`interrupted` 是启动时的补写状态，用于处理"任务跑到一半断电"的情况。

**扫描任务不进 `running`**：它没有"执行"这一步，扫描本身就是执行。硬塞一个 running 会让状态名骗人，也会让"复制任务才能改目标盘"这条边界在代码里变得含糊。

**扫描任务的边界：一份固定的目录列表**

任务创建时，参数经模板渲染、笛卡尔积展开，得到一份**确定的目录列表**——长度 N 在开跑前就定死：

```
params → 渲染模板 → 展开 → [目录₁, 目录₂, …, 目录ₙ]
         （纯函数，不读盘：N 与磁盘状态无关）

任务 = 逐个访问这 N 项，每项判定唯一状态
```

| 性质 | 含义 |
|---|---|
| 长度恒定 | 中途某台机不可达，**不是"少扫一项"，而是"这一项标成 `unreachable`"**。列表不收缩，进度分母不变 |
| 展开与磁盘无关 | 展开是纯函数（模板 + 参数），一次 `readdir` 都不做。所以"要扫哪些目录"在按下开始前就能算出来——UI 上"将扫描 1,240 个目录"就是这个 N |
| 每项恰好一个状态 | 六选一（`ok`/`empty`/`missing`/`unreachable`/`denied`/`error`），互斥且穷尽，没有"未判定"的中间态 |
| 完成条件 | N 项全部有状态；或用户取消；或任务级失败（如入口整体不可读） |

**文件是目录的内容，不是任务的单位。** 一个目录里有 0 张还是 200 张图，都只占列表里的一行。`files.jsonl` 是把这些行里的文件摊平后的**次级产物**，供复制任务消费——它不属于扫描任务的边界，删掉它扫描任务依然是完整的。

这条边界决定了两件事：进度条**必然能走到 100%**（分母恒定），以及"失败"在扫描任务里只是一个状态值，不是一次异常。

**复制任务的入口条件**：`ScanParams` 里带 `scanId`，主进程在执行前校验——

| 校验 | 失败处理 |
|---|---|
| `scanId` 对应的记录存在且 `kind === 'scan'`、`state === 'succeeded'` | `E_PARAM_INVALID`「找不到可用的扫描结果」 |
| 该扫描的 `files.jsonl` 仍在（未被清理） | `E_FS_NOT_FOUND`「扫描明细已清理，请重新扫描」 |
| 扫描时的扩展名/结构等与复制参数不冲突（扩展名来自扫描，复制不能改） | `E_PARAM_INVALID` |

**取消语义按 kind 分**：

| 任务 | 取消后 |
|---|---|
| 扫描 | 无任何副作用，已扫目录的状态保留，报告"已扫描 120 / 180" |
| 复制 | 已复制的文件保留，报告"已完成 3,200 / 4,821"；`move` 模式已删除的源文件不恢复 |

## 8. Worker 通信协议

```ts
// shared/worker-protocol.ts —— 主进程与 worker 共用

type MainToWorker =
  | { id: string; type: 'scan'; toolId: string; params: unknown }
  | { id: string; type: 'copy'; toolId: string; params: unknown; scanId: string }
  | { id: string; type: 'cancel' }
  | { id: string; type: 'ping' };

type WorkerToMain =
  | { id: string; type: 'progress'; done: number; total: number; phase: 'scanning' | 'preparing' | 'copying'; message?: string; current?: string; metrics?: Record<string, number | string | boolean> }
  | { id: string; type: 'dirs'; rows: DirRecord[] }      // 扫描明细，批量回传
  | { id: string; type: 'files'; rows: FileRecord[] }    // 文件清单，批量回传
  | { id: string; type: 'log'; level: string; message: string; ts: number }
  | { id: string; type: 'result'; data: ScanResult | ToolResult }
  | { id: string; type: 'error'; code: string; message: string; stack?: string }
  | { id: string; type: 'pong' };
```

| 约束 | 说明 |
|---|---|
| 一 worker 一任务 | 不复用进程，避免上一个任务的状态污染下一个；scan 与 copy 各自 fork |
| 进度节流在 worker 侧 | 每 100 ms 或每 200 条合并一次，跨进程消息量大时 UI 会卡 |
| 明细批量回传 | `dirs` / `files` 各按 200 条一批发送，主进程收到即追加落盘，不回传确认（丢一批最多重扫，不影响正确性） |
| 心跳 5 秒 | 15 秒无 `pong` 判定假死，kill 并按 `E_WORKER_TIMEOUT` 失败处理 |
| 只传纯数据 | 结构化克隆不支持函数、类实例、Symbol；日期统一传 ISO 字符串 |
| 错误不吞 | worker 内所有异常必须转成 `error` 消息回传，否则主进程只能看到退出码 |

## 9. IPC 契约

只走 `invoke/handle`（请求-响应）与 `send/on`（单向事件），通道名集中在 `shared/ipc-channels.ts`，payload 用 zod 校验。

| 通道 | 方向 | 入参 | 返回 |
|---|---|---|---|
| `tool:list` | invoke | — | `ToolManifest[]` |
| `task:create` | invoke | `{ toolId, kind, params }` | `{ taskId }`（创建即入队执行；`kind` = `scan` \| `copy`） |
| `task:cancel` | invoke | `{ taskId }` | `{ ok }` |
| `task:list` | invoke | `{ limit?, offset?, kind? }` | `TaskRecord[]`（`kind` 可选，用于"只看扫描"） |
| `task:get` | invoke | `{ taskId }` | `TaskRecord` |
| `task:dirs` | invoke | `{ taskId, offset, limit }` | `{ rows, total, truncated }`（读 `.dirs.jsonl`，分页，不整文件载入） |
| `task:files` | invoke | `{ taskId, offset, limit }` | `{ rows, total }`（读 `.files.jsonl`，复制前预览将复制的文件） |
| `task:exportFailures` | invoke | `{ taskId }` | `{ path }`（导出 `CSV`；不含目录明细） |
| `scan:latest` | invoke | `{ toolId }` | `TaskRecord \| null`（最近一次成功扫描，供"用上次扫描再复制一次"） |
| `entry:scan` | invoke | `{ path }` | `{ entry, regions }`（**由独立 Worker 执行**，规避 UNC 超时卡死主进程） |
| `entry:list` | invoke | — | `EntryRecord[]` |
| `entry:refresh` | invoke | `{ entryId }` | `{ entry, regions, diff }`（同由 Worker 执行） |
| `entry:remove` | invoke | `{ entryId }` | `{ ok }` |
| `template:save/list/delete` | invoke | 见 zod schema | — |
| `fs:pickDirectory/pickFiles` | invoke | `{ multi?, filters? }` | `string[]` |
| `shell:openPath` | invoke | `{ path }` | `{ ok }` |
| `update:check/download/install` | invoke | — | `{ ok }` |
| `update:testSource` | invoke | `{ kind: 'unc'\|'https', url }` | `{ ok, latencyMs, detail }` |
| `app:diagnostics` | invoke | — | `{ path }` |
| `task:progress` | event | `{ taskId, phase, done, total, current?, elapsedMs, metrics? }` | — |
| `task:log` | event | `{ taskId, level, message, ts }` | — |
| `task:state` | event | `{ taskId, state, error? }` | — |
| `update:status` | event | `{ stage, percent?, version?, mandatory? }` | — |

**preload 暴露的形状**（渲染进程唯一入口）：

```ts
window.shx = {
  tool:     { list() },
  task:     { create(p), cancel(id), list(q), get(id), dirs(q), files(q),
              onProgress(cb), onLog(cb), onState(cb) },
  scan:     { latest(toolId) },             // 最近一次成功的扫描，供"再复制一次"
  entry:    { scan(path), list(), refresh(id), remove(id) },
  template: { save(t), list(id), remove(id) },
  fs:       { pickDirectory(o), pickFiles(o) },
  shell:    { openPath(p) },
  update:   { check(), download(), install(), testSource(k, url), onStatus(cb) },
  app:      { version(), diagnostics() },
  win:      { onStateChange(cb) },          // 窗口尺寸/最大化变化，供持久化
};
```

事件订阅方法必须返回 `unsubscribe` 函数。React 组件卸载时不取消订阅，是内存泄漏和"幽灵更新"的常见来源。

## 10. 本地存储布局

```
%APPDATA%/shx-tools/
├─ config.json                         # 全局设置：更新源、窗口尺寸、lastRoute、侧栏折叠
│                                      # （zod 校验，损坏时备份并重置）
├─ tasks/                              # 任务记录，一个任务一个 JSON（扫描、复制都在这里）
│  ├─ <taskId>.json                    # 任务记录：kind、状态、参数快照、统计、失败清单
│  ├─ <taskId>.dirs.jsonl              # 目录明细（仅扫描任务；保留最近 50 条）
│  └─ <taskId>.files.jsonl             # 文件清单（仅扫描任务；保留最近 50 条）
├─ templates/                          # 参数模板（按 tool 隔离）
│  └─ <toolId>/<name>.json
├─ data/                               # 工具专属私有持久化数据
│  └─ image-collector/
│     └─ categories.json               # 按产品类别收拢的入口、机台扫描缓存与不良历史（形态1）
├─ logs/
│  └─ app-2026-10-23.log               # 按天滚动，保留 14 天
└─ cache/
   └─ updates/                         # 更新包下载缓存
```

**`config.json` 的分工**：跨工具、跨会话都要用的东西才放这里——更新源、窗口尺寸与位置、`lastRoute`（启动恢复上次页面）、侧栏折叠状态。**不放业务数据**，业务数据一律进 `data/<toolId>/` 或 `templates/<toolId>/`。

**任务记录结构**

**两类任务同一套 schema，一个任务一个文件**。`kind` 是字段，不是目录——任务中心要的是"按时间排一个列表"，分成 `tasks/scan/` 和 `tasks/copy/` 反而要在读的时候合并两处。

扫描任务（`tasks/20261023-101532-a1b2.json`）：

```json
{
  "id": "20261023-101532-a1b2",
  "toolId": "image-collector",
  "kind": "scan",
  "state": "succeeded",
  "params": {
    "entryPath": "D:\\桌面\\利珀-在线PL",
    "region": "东区",
    "machines": ["6B", "8B", "10B"],
    "date": "2026-10-23",
    "shift": "day",
    "hours": ["08", "09", "10", "11", "12", "13", "14"],
    "defects": ["明暗片", "面划伤"],
    "extensions": ["jpg", "png", "bmp"]
  },
  "startedAt": "2026-10-23T13:58:04+08:00",
  "finishedAt": "2026-10-23T13:58:46+08:00",
  "summary": {
    "dirs": 180, "files": 4821, "totalBytes": 8849018880,
    "byStatus": { "ok": 162, "empty": 12, "missing": 5, "unreachable": 1, "denied": 0, "error": 0 }
  },
  "dirsTruncated": false,
  "artifacts": [{ "label": "入口", "path": "D:\\桌面\\利珀-在线PL" }]
}
```

复制任务（`tasks/20261024-140210-9e7f.json`）：

```json
{
  "id": "20261024-140210-9e7f",
  "toolId": "image-collector",
  "kind": "copy",
  "state": "running",
  "sourceScanId": "20261023-101532-a1b2",
  "params": {
    "targetDir": "E:\\collected",
    "layout": "tree",
    "conflict": "rename",
    "operation": "copy",
    "dedupe": false
  },
  "startedAt": "2026-10-24T14:02:10+08:00",
  "finishedAt": null,
  "summary": { "copied": 3200, "skipped": 12, "failed": 0, "totalBytes": 8849018880 },
  "failures": [],
  "artifacts": [{ "label": "目标目录", "path": "E:\\collected" }]
}
```

**参数是快照，不是引用**。记录里存的是当次实际用的完整参数，不存"指向模板的 id"——模板被改被删都不影响历史记录的可读性。这也是详情页「重新扫描 / 再复制一次」能回填的前提。

| 策略 | 规则 |
|---|---|
| 原子写 | 先写 `<id>.json.tmp`，`fsync` 后 `rename` 覆盖，避免断电产生半截 JSON |
| **创建即写** | `created` 一落定就写第一份（含 `kind`、`params`、`startedAt`）。进程此时崩掉，任务中心也能看到这条记录并被标成「已中断」 |
| 状态迁移即写 | 每次 `state` 变化立即写。一个任务最多 3 次迁移，不值得节流 |
| 运行中指标 | 每 2 秒或每 500 条更新 `summary`，覆盖写 |
| 终态 | 立即写并 `fsync`，**写完才推 `task:state`**——否则界面显示"已完成"而磁盘上没有，重启就丢 |
| 退出补写 | 非终态记录在下次启动时补写 `interrupted` |
| 写失败 | 记日志、任务继续跑；连续 3 次失败弹一次「任务记录无法写入（磁盘满或无权限）」，不阻断主流程 |
| 损坏恢复 | 解析失败时把坏文件改名为 `.corrupt`，UI 显示"记录损坏"而非白屏 |
| 滚动清理 | 按 `kind` 分别计算，各保留 200 条，按 `startedAt` 删最旧的，不删运行中的任务 |
| 引用保护 | 清理扫描记录前检查是否被复制任务引用；被引用时**连明细一起保留**，直到该复制任务也出榜 |

**为什么一个任务一个文件，而不是一个 `tasks.json` 装全部**：

| 理由 | 说明 |
|---|---|
| 原子性 | 追加到同一个大文件需要"读-改-写"整份，20 个任务并发跑时必然互相覆盖 |
| 损坏隔离 | 单条记录写坏只影响一条，大文件写坏全丢 |
| 写入成本 | 运行中每 2 秒更新一次，大文件每次都要重写全量，记录越多越慢 |
| 排查 | 出问题直接打开 `20261024-140210-9e7f.json`，不用在几千行里搜 |

**重启后怎么恢复**：启动时列 `tasks/*.json` → 非终态补 `interrupted` → 任务中心直接读目录渲染，**不另建索引文件**（200 条量级，一次 `readdir` + 200 次小读在 SSD 上是毫秒级）。

**目录明细（`<taskId>.dirs.jsonl`）**

`TaskRecord` 里只有汇总与失败清单，装不下"每个目录扫到了什么"。F1 的六状态明细单独落一个 JSONL 文件，一行一个目录：

```json
{"path":"6B\\2026.10.23\\白班\\13\\A\\明暗片","status":"ok","files":28,"bytes":10485760,"elapsedMs":120}
```

| 项 | 规则 |
|---|---|
| 写入时机 | 扫描中每完成一个目录立即追加一行；进程崩溃最多丢最后一行 |
| 顺序 | 保持笛卡尔积展开顺序，**不排序**——顺序本身就是排查线索 |
| 上限 | 单任务 50,000 行（远超 20,000 组合上限）；超出停止写入，任务记录里置 `dirsTruncated: true` |
| 读取 | 详情页按 `offset/limit` 分页读，不把整个文件载入渲染进程 |
| 清理 | **只保留最近 50 个扫描任务**的明细；运行中的任务不删；被复制任务引用的扫描不删（见上表「引用保护」） |
| 缺失容忍 | 文件不存在时详情页显示"明细已清理，只能看汇总"，不报错、不重试 |
| 体积 | 2 万行约 2 MB；50 条命中上限时约占 100 MB |

> 为什么不塞进 `<taskId>.json`：明细是追加写的高频数据，混进汇总文件会让"每 2 秒原子重写"的成本随扫描行数线性增长。分成两个文件后，汇总写起来仍是常数开销。

**文件清单（`<taskId>.files.jsonl`）**

扫描任务产出的第二个明细文件，一行一个待复制文件，**复制任务的输入就是它**：

```json
{"src":"\\\\10.108.9.153\\...\\IMG_0142.jpg","dest":"2026-10-23\\东区\\6B\\明暗片\\13\\A\\IMG_0142.jpg","bytes":3145728,"hash":"sha256:ab12..."}
```

| 项 | 规则 |
|---|---|
| 写入时机 | 扫描中每发现一个可收集文件追加一行（`dest` 在扫描阶段就定好，复制阶段不再算） |
| 数量级 | 单次扫描通常 3,000~9,000 行，约 1~2 MB |
| `hash` | 仅在开启内容去重时计算；关闭时该字段缺省，复制阶段也不重复算 |
| 用途 | 复制任务载入它建 CopyPlan；`task:files` 分页读给界面预览"将要复制什么" |
| 清理 | 与 `.dirs.jsonl` 同生命周期 |

> 扫描阶段就把 `dest` 定下来，是为了让"复制"变成纯搬运：复制任务不再解析 `.lnk`、不再渲染模板、不再猜产品类型。模板改了要重扫，这是特性不是缺陷——否则同一份清单会在两次执行里产出不同路径。

> 本期不引入 SQLite。JSON 文件足以支撑 200 条任务记录，零原生依赖、易排查。任务量增长后再迁移。

## 11. 错误处理模型

错误按影响范围分三级，处理方式不同：

| 级别 | 典型场景 | 处理 | 用户感知 |
|---|---|---|---|
| **单条可恢复** | 某个文件被占用、单个目录无读取权限 | 记入 `failures`，继续后续条目 | 结束后在失败清单里看到 |
| **任务级失败** | 源目录不存在、输出目录不可写、目标磁盘满 | 终止任务，状态 `failed`，保留已完成部分 | 明确错误文案 + 已完成计数 |
| **应用级异常** | worker 崩溃、主进程未捕获异常 | 捕获上报，提示重试，写诊断日志 | 一次弹窗，可重试 |

```ts
// shared/errors.ts
export interface TaskError {
  code: string;        // E_FS_PERM / E_NET_TIMEOUT / E_PARAM_INVALID ...
  message: string;     // 面向用户的完整句子
  detail?: string;     // 技术细节，默认折叠
  retryable: boolean;  // 决定是否显示「重试」按钮
}
```

错误码按域分段（`E_PARAM_*` / `E_FS_*` / `E_NET_*` / `E_LNK_*` / `E_WORKER_*`），便于日志检索与统计。**UI 只展示 `message`**，`detail` 折叠在"技术详情"里——让非技术同事看到 `EBUSY: resource busy or locked` 没有意义。

**标准错误码与映射**

| 错误域 | 错误码 (`code`) | 默认用户文案 (`message`) | 可重试 |
|---|---|---|---|
| **参数校验** | `E_PARAM_INVALID` | 参数格式不合法 | 否 |
| | `E_PARAM_TOO_LARGE` | 组合数超出最大限制（20,000） | 否 |
| **文件系统** | `E_FS_NOT_FOUND` | 指定的文件或目录不存在（ENOENT） | 否 |
| | `E_FS_PERM` | 没有访问或写入权限（EACCES/EPERM） | 否 |
| | `E_FS_BUSY` | 文件正被其他程序占用（EBUSY） | 是 |
| | `E_FS_DISK_FULL` | 磁盘存储空间不足 | 否 |
| **网络与UNC** | `E_NET_TIMEOUT` | 网络连接超时，机台可能已关机或断网（ETIMEDOUT） | 是 |
| | `E_NET_UNREACHABLE` | 网络不可达或共享未开启（EHOSTUNREACH/ENETUNREACH） | 是 |
| | `E_NET_DENIED` | 网络共享拒绝访问（缺少网络凭据），可通过资源管理器认证 | 否 |
| **快捷方式** | `E_LNK_BROKEN` | 快捷方式文件损坏或无效 | 否 |
| | `E_LNK_CONFLICT` | 快捷方式目标主机存在歧义，需人工确认 | 否 |
| **Worker生命周期** | `E_WORKER_CRASH` | 执行进程异常崩溃，可重新发起 | 是 |
| | `E_WORKER_TIMEOUT` | 执行进程无响应（假死） | 是 |

系统底层异常必须在基础设施层通过 `normalizeSystemError(err)` 转为统一 `TaskError` 后再向上传递。

## 12. 并发与资源控制

### 12.1 资源并发配额

| 资源 | 限制 | 依据 |
|---|---|---|
| 全局并发任务 | 2 | 超过后互相拖慢磁盘与网络，收益为负 |
| 单工具并发任务 | 1（**不区分 kind**） | 同一工具的 scan 与 copy 也不许并行：copy 依赖 scan 的清单，且两者抢同一条 UNC 链路 |
| 同一扫描的并发复制 | 1 | 两个复制任务写同一个目标目录会互相覆盖；`TaskManager` 按 `sourceScanId` 去重 |
| 目录遍历并发 | 本地 8 / UNC 4 | UNC 并发过高反而更慢，且会压垮共享 |
| 文件复制并发 | 本地 8 / UNC 4 | 与遍历共用一个并发池，避免总量失控 |
| 单文件读取 | 流式，逐行处理 | 内存占用与文件行数解耦 |

并发池用 `infra/limit.ts` 实现（信号量 + 队列），不引入第三方依赖——需求太简单，一个 40 行的类足够，且便于加"取消时清空队列"。

### 12.2 机台级网络探活与快速熔断（Circuit Breaker）

Windows 原生 SMB 客户端在遇到离线或断网的目标 IP 时，系统内核调用（如 `fs.readdir` / `fs.stat`）会陷入 20~60 秒的漫长超时重试。若一台机台关机，盲目遍历其 60 个时段组合会导致任务阻塞长达数十分钟。

**探活机制**（`infra/network/probe.ts`）：
1. **机台前置探测**：在展开扫描某机台的组合之前，先对机台根（UNC 共享或对应 IP）执行极简轻量探活（优先尝试 TCP 445/139 端口连接，超时阈值设为 1.5 秒）。
2. **熔断与快衰**：若探活失败，触发机台级熔断，不再对该机台名下的任何子目录发起网络 I/O，直接将其所有组合判定为 `unreachable`（`E_NET_UNREACHABLE` / `E_NET_TIMEOUT`），并立即推进至下一机台。
3. **收益**：将单个离线机台引起的阻塞时间从“60 组合 × 20 秒 = 20 分钟”降至“1 次探测 1.5 秒”，杜绝 UI 与执行队列假死。

### 12.3 两级优雅取消协议（Two-Tier Cancellation）

任务取消必须保证确定性与零副作用：

1. **第一级：优雅中止（Graceful Abort）**
   - 主进程收到取消请求后，向 Worker 发送 `{ type: 'cancel' }` 消息；
   - Worker 内触发 `AbortController.abort()`，`signal.aborted` 转为 `true`；
   - 任务循环立即清空待执行队列，停止分派新 I/O；
   - 正在进行的流式写入主动关闭流，并异步清理未写完的临时文件（见 12.4）；
   - Worker 汇总当前已完成指标，回传终态 `ToolResult`，主进程标记任务为 `canceled`。
2. **第二级：超时强杀（Force Kill）**
   - 主进程发出取消指令后启动 3 秒看门狗定时器；
   - 若 Worker 因系统调用深层阻塞在 3 秒内未响应退出，主进程直接调用 `utilityProcess.kill()` 强行终止；
   - 状态机记录 `canceled` 并附带说明“进程已被强制回收”。

### 12.4 文件原子写入与残损清理（Atomic Copy）

在批量复制数千张图片时，若中途发生断电、用户取消、网络断开或磁盘满，直接覆盖目标文件极易造成“半截破损图片”（文件大小异常、无法查看）。

**安全复制策略**：
1. 复制过程中，目标文件一律先写入临时后缀：`${dest}.shx-part`；
2. 数据写入完成并通过 `stat.size` 校验后，通过原子操作 `fs.rename` 转正为最终目标文件名；
3. 任何复制异常或收到 `signal.aborted` 时，立即捕获并执行 `fs.unlink(partPath)`，确保目标目录中绝不残留 0 字节或破损文件。

---

## 13. 技术栈

| 项 | 选择 | 说明 |
|---|---|---|
| 运行时 | **Electron 44.9.x**（已定） | 8 月发布、已出 9 个补丁，行为稳定；EOL 2027-03。45 于 2026-10-21 才发布，1~2 个月后再评估升级 |
| 构建 | Vite 8 + electron-vite | 三端统一，HMR 体验好 |
| UI | React 19 + Ant Design 6.6.7 | antd 6.6.7，采用 CSS 变量主题，体积与切换性能优于 v5 |
| 语言 | TypeScript 5.x（strict） | 主/渲染/worker 共享类型 |
| 状态 | Zustand | 轻量，任务进度这类高频更新不需要 Redux |
| 路由 | React Router 7（Hash 模式） | 打包后 `file://` 加载必须用 hash |
| 表格 | antd Table（分页） | F1 结果按目录计（百级），分页或截断渲染即可 |
| 图片尺寸 | image-size | 只读文件头，成本低 |
| Schema 校验 | zod | 主进程入参校验 + 配置校验 |
| 日志 | electron-log | 开箱即用，支持文件滚动 |
| 打包 | electron-builder 26 | NSIS + ZIP 双目标 |
| 更新 | electron-updater（仅安装版）+ 自研（免安装版） | 见《需求与方案设计》4.3 |
| 测试 | Vitest + Playwright(Electron) | 纯逻辑单测 + 关键路径冒烟 |

---

## 14. 工程结构

### 14.1 目录总览

```
shx-tools/
├─ electron/                        # 主进程与 preload（Node 环境）
│  ├─ main.ts                       # 入口：单实例、协议注册、生命周期
│  ├─ app/
│  │  ├─ window.ts                  # BrowserWindow 创建、尺寸记忆
│  │  ├─ menu.ts                    # 应用菜单（含开发者工具开关）
│  │  ├─ single-instance.ts         # 单实例锁，二次启动激活已有窗口
│  │  └─ crash-guard.ts             # 未捕获异常兜底与重启策略
│  ├─ preload/
│  │  ├─ index.ts                   # contextBridge 暴露 window.shx
│  │  └─ api.d.ts                   # 渲染进程的类型声明
│  ├─ ipc/
│  │  ├─ router.ts                  # 统一注册、zod 校验、错误包装
│  │  ├─ task.channel.ts
│  │  ├─ fs.channel.ts
│  │  ├─ template.channel.ts
│  │  └─ app.channel.ts
│  ├─ core/
│  │  ├─ task/
│  │  │  ├─ task-manager.ts         # 状态机、并发闸门、事件分发
│  │  │  ├─ task-state.ts           # 合法迁移表（纯函数，可单测）
│  │  │  └─ task-store.ts           # 记录读写、滚动清理、损坏恢复
│  │  ├─ worker/
│  │  │  ├─ worker-host.ts          # fork / kill / 消息编解码
│  │  │  ├─ heartbeat.ts            # 心跳与假死判定
│  │  │  └─ pool.ts                 # 全局并发与单工具并发闸门
│  │  ├─ tool-registry.ts           # 工具清单（主进程侧）
│  │  ├─ storage/
│  │  │  ├─ config-store.ts
│  │  │  ├─ template-store.ts
│  │  │  └─ atomic-write.ts         # tmp + fsync + rename
│  │  └─ logger.ts                  # 分级、滚动、脱敏
│  ├─ updater/
│  │  ├─ index.ts                   # 形态判定（安装版 / 免安装）与编排
│  │  ├─ feed/
│  │  │  ├─ resolver.ts             # 源优先级与降级
│  │  │  ├─ unc-client.ts           # UNC 探测与读取
│  │  │  └─ https-client.ts         # HTTPS 探测与下载
│  │  ├─ local-proxy.ts             # UNC → 127.0.0.1 静态服务
│  │  ├─ nsis-updater.ts            # electron-updater 封装
│  │  └─ portable-updater.ts        # 检查 + 提示下载
│  └─ worker/
│     └─ entry.ts                   # utilityProcess 入口，按 toolId 分发
├─ src/                             # 渲染进程
│  ├─ main.tsx
│  ├─ App.tsx
│  ├─ router.tsx                    # Hash 路由；'/' 重定向到 lastRoute 或第一个工具
│  ├─ layout/
│  │  ├─ AppLayout.tsx              # 侧栏 + Header + Content 三段式
│  │  └─ SideNav.tsx                # 功能清单，工具区由 tool:list 生成
│  ├─ pages/
│  │  ├─ tool/
│  │  │  ├─ ToolPage.tsx            # 按 toolId 渲染运行时表单
│  │  │  ├─ components/
│  │  │  │  └─ TaskSummaryCard.tsx  # 副栏：预估 / 进度 / 完成 / 失败 四态
│  │  │  └─ custom/
│  │  │     ├─ ImageCollectorForm.tsx # F1 自定义表单（前端专用组件）
│  │  │     ├─ MachineGrid.tsx        # 机台选择（形态 A 单选区域 / 形态 B 分组）
│  │  │     ├─ HourPicker.tsx         # 时段勾选，候选随班次变化
│  │  │     └─ DefectInput.tsx        # 不良类型输入 + 历史
│  │  ├─ task/
│  │  │  ├─ TaskListPage.tsx
│  │  │  ├─ TaskDetailPage.tsx
│  │  │  └─ components/
│  │  │     ├─ ProgressPanel.tsx     # 工具页 compact / 详情页 full
│  │  │     ├─ LogPanel.tsx
│  │  │     ├─ PreviewTable.tsx      # 目录明细，工具页实时 + 详情页回看共用
│  │  │     └─ ResultSummary.tsx
│  │  └─ settings/
│  │     ├─ SettingsPage.tsx
│  │     └─ sections/
│  │        ├─ GeneralSection.tsx
│  │        ├─ UpdateSection.tsx    # UNC / HTTPS 源配置与测试连接
│  │        └─ AboutSection.tsx
│  ├─ components/
│  │  ├─ SchemaForm/
│  │  │  ├─ index.tsx               # schema → 表单
│  │  │  ├─ fields/                 # path / fileList / number / enum / switch
│  │  │  └─ coerce.ts               # 表单值 → 参数对象
│  │  ├─ PathPicker.tsx             # 路径输入：粘贴清洗、长路径省略、就地校验
│  │  ├─ StatusTag.tsx              # 六种目录状态（图标 + 文字 + 颜色三重编码）
│  │  └─ EmptyState.tsx             # 首次 / 真空 / 筛选空 三种写法
│  ├─ stores/
│  │  ├─ task-store.ts              # zustand：任务列表与实时进度
│  │  └─ settings-store.ts
│  └─ styles/
├─ tools/                           # 业务工具，只依赖 shared + infra
│  ├─ index.ts                      # 静态注册表
│  └─ image-collector/
│     ├─ manifest.ts                # 元数据 + 两种 kind 各自的 paramsSchema
│     ├─ executor.ts                # 分发：kind=scan → scan.ts，kind=copy → copy.ts
│     ├─ scan.ts                    # 入口扫描 → 展开 → 逐目录 scanOne → 回传明细
│     ├─ copy.ts                    # 载入 files.jsonl → 建 CopyPlan → 目标预检 → 复制
│     ├─ lnk.ts                     # .lnk 手写 Buffer 解析（纯 Node，参考 lnk 样本）
│     ├─ template.ts                # 产品路径模板与渲染
│     ├─ expand.ts                  # 笛卡尔积（直接物化 ScanUnit 数组）
│     ├─ filter.ts                  # 纯函数：扩展名 / 去重判定
│     ├─ scanner.ts                 # scanOne：列目录、归类六种状态
│     └─ copier.ts                  # 复制 / 冲突 / 去重
├─ infra/                           # 与业务无关的基础设施
│  ├─ fs/
│  │  ├─ walk.ts                    # 并发目录遍历（可取消）
│  │  ├─ copy.ts                    # 复制与同名冲突策略
│  │  ├─ long-path.ts               # \\?\ 前缀处理
│  │  ├─ hash.ts                    # 分尺寸分组后的 SHA-256
│  │  └─ image-meta.ts              # 读文件头取宽高
│  └─ limit.ts                      # 信号量并发池
├─ shared/                          # 三端共享，零运行时依赖（除 zod）
│  ├─ ipc-channels.ts
│  ├─ tool-contract.ts
│  ├─ worker-protocol.ts
│  ├─ errors.ts                     # 错误码枚举与构造器
│  └─ schemas/
│     ├─ config.schema.ts
│     ├─ task.schema.ts
│     └─ template.schema.ts
├─ tests/
│  ├─ unit/
│  │  ├─ lnk.spec.ts                # .lnk 二进制解析、优先级与冲突检测
│  │  ├─ template.spec.ts           # 产品路径模板渲染与字面值校验
│  │  ├─ cartesian.spec.ts          # 字段笛卡尔积展开与上限保护
│  │  ├─ filter.spec.ts             # 扩展名与同名文件过滤
│  │  ├─ long-path.spec.ts          # \\?\ 前缀与路径规范化
│  │  └─ task-state.spec.ts         # 状态机合法流转与非法拦截
│  ├─ integration/
│  │  ├─ copy.spec.ts               # 临时目录真实复制、重试与去重
│  │  └─ scan.spec.ts               # 模拟目录扫描与六类状态归类
│  ├─ smoke/
│  │  └─ app.spec.ts                # Playwright + Electron 冒烟
│  └─ fixtures/                     # lnk/ 样本、测试图片、异常损坏文件
├─ build/
│  ├─ icon.ico
│  ├─ icon.icns
│  ├─ installer.nsh                 # NSIS 自定义脚本
│  └─ build-config.json             # 默认更新源（构建时注入）
├─ scripts/
│  ├─ release.mjs                   # 生成 update.json、校验与打包
│  └─ new-tool.mjs                  # 脚手架：生成工具目录骨架
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ tsconfig.json
├─ tsconfig.node.json
├─ tsconfig.web.json
├─ eslint.config.js
└─ package.json
```

### 14.2 目录职责与依赖许可

| 目录 | 职责 | 允许依赖 | 禁止依赖 |
|---|---|---|---|
| `shared/` | 类型、常量、错误码、zod schema | zod | Node API、electron、任何上层 |
| `infra/` | 文件、并发、哈希等通用能力 | `shared`、Node 内置 | `tools`、`core`、业务词汇 |
| `tools/` | 具体工具的业务实现 | `shared`、`infra` | `core`、`ipc`、`electron` |
| `electron/worker/` | 执行宿主，按 toolId 分发 | `tools`、`infra`、`shared` | `electron` 的 UI 模块 |
| `electron/core/` | 编排、状态、存储、更新 | `shared`、`infra` | 直接调用 `tools` 的业务函数 |
| `electron/ipc/` | 通道注册与参数校验 | `core`、`shared` | 业务逻辑 |
| `electron/preload/` | 暴露白名单 API | `shared` 类型 | `ipcRenderer` 原样透传 |
| `src/` | 界面与交互 | `shared` 类型、`window.shx` | `fs`、`electron`、`tools/*` |

**设计意图**：`tools/` 与 `infra/` 不知道 electron 的存在，因此可以脱离桌面环境直接跑单元测试；`src/` 不知道文件系统存在，因此换 UI 框架不影响业务。

### 14.3 依赖规则的落地

规则写在文档里没用，必须让构建失败。`eslint.config.js` 关键片段：

```js
export default [
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['electron', 'electron/*'], message: '渲染进程请使用 window.shx' },
          { group: ['node:*', 'fs', 'path', 'child_process'], message: '渲染进程不得使用 Node API' },
          { group: ['@tools/*', '@infra/*'], message: '渲染进程只允许依赖 @shared' },
        ],
      }],
    },
  },
  {
    files: ['tools/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['electron', 'electron/*'], message: '工具不得依赖 electron' },
          { group: ['@core/*', '@ipc/*'], message: '工具不得依赖编排层' },
        ],
      }],
    },
  },
];
```

### 14.4 构建配置

`electron.vite.config.ts` 的关键结构：

```ts
import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      sourcemap: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts'),
          worker: resolve(__dirname, 'electron/worker/entry.ts'), // worker 作为独立入口
        },
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared'),
        '@infra': resolve(__dirname, 'infra'),
        '@tools': resolve(__dirname, 'tools'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload/index.ts'),
        },
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared'),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    plugins: [react()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      sourcemap: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/index.html'),
        },
      },
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src'),
        '@shared': resolve(__dirname, 'shared'),
      },
    },
  },
});
```

| 配置点 | 取值 | 原因 |
|---|---|---|
| main / preload 格式 | CJS | Electron 主进程加载最稳，避免 ESM 的 `.mjs` 边界问题 |
| worker 入口 | 独立 entry | `utilityProcess.fork` 需要真实文件路径，不能是 asar 内的虚拟路径 |
| renderer 路由 | Hash 模式 | 生产环境用 `file://` 加载，History 模式会 404 |
| sourcemap | 生产关闭 | 减小包体；崩溃栈通过符号表离线还原 |
| 版本号 | `define` 注入 | UI 显示版本，避免运行时读 package.json |

**worker 的打包坑与跨环境寻址**：
`out/main/worker.js` 打包后会默认封入 asar，而 `utilityProcess.fork` 需要底层操作系统的真实文件路径，无法从 asar 内加载。
* 解决方案：通过 `asarUnpack` 将其解包（见 14.5），并在 `electron/core/worker/worker-host.ts` 中统一封装跨环境定位函数：
```ts
export function getWorkerEntryPath(): string {
  if (app.isPackaged) {
    // 生产环境：位于 app.asar.unpacked 真实物理路径
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'worker.js');
  }
  // 开发环境：与 main.js 位于同一输出目录
  return path.join(__dirname, 'worker.js');
}
```

### 14.5 打包配置

```yaml
appId: com.shx.tools
productName: shx-tools
directories:
  output: release
  buildResources: build

files:
  - out/**/*
  - package.json

asar: true
asarUnpack:
  - out/main/worker.js        # utilityProcess 需要磁盘真实路径

win:
  icon: build/icon.ico
  target:
    - target: nsis
      arch: [x64]
    - target: zip
      arch: [x64]

nsis:
  oneClick: false                       # 显示安装向导
  perMachine: false                     # 装到用户目录，不触发 UAC
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  artifactName: shx-tools-Setup-${version}.exe

zip:
  artifactName: shx-tools-${version}-win-x64.zip

publish:
  provider: generic
  url: https://updates.invalid/         # 占位，仅为触发 latest.yml 生成
```

| 配置点 | 说明 |
|---|---|
| `publish.url` 必须存在 | electron-builder 没有 publish 配置时**不会生成 `latest.yml`**，更新链路直接断掉。但运行时并不用它——feed 地址由 config.json 决定，这里的 URL 只是占位 |
| `perMachine: false` | 装到 `%LOCALAPPDATA%`，免管理员权限。代价是每用户一份，机器上有多个账号会重复安装 |
| 不配 `certificateFile` | 已确认无签名证书。构建时会警告，属预期 |
| `asarUnpack` 只放 worker | 其余全部进 asar，减少文件数、加快启动 |
| macOS 产物 | 仅本地开发调试用，不产出 dmg（无签名无公证，分发无意义） |

### 14.6 编码约定

| 约定 | 说明 |
|---|---|
| TS `strict` + `noUncheckedIndexedAccess` | 数组下标访问必须显式判空，避免大量 `undefined` 运行时错误 |
| 禁止 `any` | 边界处用 `unknown` + zod 收窄；确需断言时写 `as` 并附注释说明依据 |
| 导入顺序 | `node:*` → 第三方 → `@shared` / `@infra` / `@tools` → 相对路径，用 ESLint 自动排序 |
| 不用 barrel 文件 | 禁止层层 `index.ts` re-export，会拖慢构建并掩盖循环依赖 |
| 纯函数与 IO 分离 | 所有判定、清洗、聚合逻辑写成纯函数放独立文件，便于单测 |
| 路径处理集中 | 统一走 `infra/fs/long-path.ts`，业务代码不直接拼字符串 |
| 时间格式 | 存储一律 ISO 8601 字符串，不存 `Date` 对象（JSON 序列化后类型丢失） |
| 文件命名 | 普通模块 `kebab-case.ts`，React 组件 `PascalCase.tsx` |
| 日志脱敏 | 路径只保留盘符与层级（`D:\***\***\x.jpg`），不打印完整用户路径 |

### 14.7 测试策略

| 类型 | 覆盖对象 | 工具 | 目标 |
|---|---|---|---|
| 单元 | 条件判定、表头合并、数字清洗、聚合、状态迁移、路径处理 | Vitest | 行覆盖率 ≥ 70%，核心纯函数 ≥ 90% |
| 集成 | 真实临时目录下的复制/冲突/取消；fixture xlsx 的读取与导出 | Vitest + `os.tmpdir()` | 关键路径全覆盖，含异常分支 |
| 冒烟 | 启动 → 跑一个 fixture 任务 → 断言输出文件存在 | Playwright（Electron） | 每次发布前必跑 |

**明确不做**：UI 快照测试（改一次样式全红，维护成本高于收益）、全分支 E2E（单人维护撑不住）。

**UNC 的测试限制**：CI 环境无法模拟 SMB 共享。策略是——把"路径类型判定"抽成纯函数单测覆盖，把真实 UNC 行为列入发布前的人工检查清单（断网、无权限、超时三种情况各验一次）。

### 14.8 质量门禁与发布流程

```
提交前   lint-staged（eslint --fix + prettier）
   │
CI       typecheck → lint → unit → integration → build（Windows + macOS 双平台）
   │
发布     手动打 tag → release.mjs
          ├─ 校验 package.json version 与 CHANGELOG 一致
          ├─ 构建 NSIS + ZIP
          ├─ 生成 update.json（读 version / sha512 / size）
          ├─ 校验 latest.yml 存在且版本号与 update.json 一致，不一致直接失败
          └─ 上传到 UNC 与 HTTPS 两个源
```

`release.mjs` 里"两份清单版本必须一致"这条校验不能省。手工发版时最容易犯的错，就是只更新了一处，导致安装版提示没有更新、免安装版提示有更新。

---

## 15. 项目初始化（M0）

**初始化方式（已定）**：用 `electron-vite` 官方脚手架生成，只取构建配置，示例代码全部删除。

```bash
npm create @quick-start/electron@latest shx-tools -- --template react-ts
```

| 时段 | 任务 | 完成判据 |
|---|---|---|
| 0.5 天 | 生成、清理示例、目录重排、alias | 目录符合 14.1；`npm run dev` 起空窗口，无残留示例页 |
| 0.5 天 | worker 入口、asarUnpack、双目标打包 | **安装后的 exe** 能 fork 出 worker 并往返一条消息 |
| 1.5 天 | 任务骨架：状态机、worker-host、IPC 路由、日志、假工具 | 假工具跑通 `scan → 落盘明细 → copy → 报告` 两条任务链路 |
| 0.5 天 | 联调修补 | 无阻塞缺陷 |

**改造清单（逐项打勾）**

| # | 项 | 要点 |
|---|---|---|
| 1 | 删除示例代码 | 移除 `ping/pong` IPC、示例页面、示例更新逻辑。示例代码会被后续开发模仿，必须删干净 |
| 2 | 目录重排 | 改为 `electron/` + `src/` + `tools/` + `infra/` + `shared/`，与 14.1 一致 |
| 3 | worker 独立入口 | `rollupOptions.input` 增加 `worker: 'electron/worker/entry.ts'` |
| 4 | asarUnpack | 解包 `out/main/worker.js`，运行时区分开发态与打包态路径 |
| 5 | 双目标打包 | NSIS + ZIP；`publish` 填占位 URL（否则不生成 `latest.yml`） |
| 6 | alias | `@shared` / `@infra` / `@tools` / `@renderer`，三个 tsconfig 的 `paths` 同步 |
| 7 | ESLint 边界 | 按 14.3 配置 `no-restricted-imports`，让越层依赖直接报错 |
| 8 | 基础库 | React Router（Hash 模式）、zustand、zod，一次装好并锁版本 |
| 9 | 移除 macOS 打包目标 | 保留开发调试能力，不产出 dmg |

**M0 的验收标准**

不是"`npm run dev` 能看到界面"，而是：**把 NSIS 安装包装到一台干净机器上，启动、跑完一个假任务、看到报告**。

开发态与打包态在 worker 路径、asar 加载、preload 解析上都有差异，只有打包后才暴露。这一条如果不作为验收标准，M3 会一次性还清所有债。

---

## 附录：架构决策速查

| 决策 | 选择 | 一句话理由 |
|---|---|---|
| 重任务放哪 | `utilityProcess` | 独立崩溃域、可 kill、不阻塞 UI |
| 工具如何接入 | 静态注册 + `ToolExecutor` 契约 | 数量有限，类型安全优于动态加载 |
| 状态谁写 | 仅主进程 `TaskManager` | 单点写避免 UI 与磁盘不一致 |
| 任务怎么切 | **扫描任务 / 复制任务两类**，清单落盘传递 | 副作用不同、失败归因不同、清单可复用；`preview/confirm` 三个概念随之删除 |
| 业务层能否碰 electron | 不能 | 脱离桌面环境可单测 |
| 任务记录存哪 | JSON 文件 + 原子写 | 200 条量级，零原生依赖 |
| 并发上限 | 全局 2 / 单工具 1（不分 kind） | 超过后互相拖慢，收益为负 |
