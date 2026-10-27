/**
 * 工具契约：框架与具体工具之间唯一的接缝。
 * 工具只实现 ToolExecutor，不碰 electron、IPC、窗口。
 */

export type TaskKind = 'scan' | 'copy'
export type TaskPhase = 'preparing' | 'scanning' | 'copying'

/** JSON Schema 子集：M0 只用来喂表单与校验，不求完整 */
export type JSONSchema = Record<string, unknown>

export interface ToolManifest {
  id: string
  name: string
  version: string
  description: string
  category: 'file' | 'network' | 'utility'
  kinds: TaskKind[]
  /** 每个 kind 一份入参 schema；由 zod 生成，不手写第二份 */
  paramsSchema: Partial<Record<TaskKind, JSONSchema>>
  ui?: 'auto' | 'custom'
  icon?: string
}

export type DirStatus = 'ok' | 'empty' | 'missing' | 'unreachable' | 'denied' | 'error'

export interface DirRecord {
  path: string
  combo?: Record<string, string>
  status: DirStatus
  fileCount: number
  bytes: number
  elapsedMs: number
  code?: string
}

export interface FileRecord {
  src: string
  dest: string
  bytes: number
  hash?: string
}

export interface ScanSummary {
  dirCount: number
  fileCount: number
  bytes: number
  byStatus: Record<DirStatus, number>
  diagnostics?: Record<string, number>
}

export interface ScanResult {
  summary: ScanSummary
}

export interface ToolFailure {
  src: string
  dest?: string
  reason: string
  code?: string
  stage?: 'scan' | 'copy'
}

export interface CopySummary {
  planned: { fileCount: number; bytes: number }
  copied: { fileCount: number; bytes: number }
  conflict: { renamed: number; overwritten: number; skippedExisting: number }
  skippedDuplicate: number
  /** 续传时认领回来的项 */
  adopted: number
  failed: { fileCount: number }
}

export type ToolSummary = Record<string, number | string> | CopySummary

export interface ToolResult {
  summary: ToolSummary
  artifacts?: { label: string; path: string }[]
  failures?: ToolFailure[]
}

export interface ProgressEvent {
  done: number
  total: number
  phase: TaskPhase
  message?: string
  current?: string
  metrics?: Record<string, number | string>
}

/**
 * 工具执行期上下文：只暴露必要能力，不给 electron / IPC。
 *
 * `taskId` / `sourceTaskDir` / `resumeFrom` 为 M0 实施时补充，已回写《架构》v0.10 第 6 章：
 * 执行器需要它们定位自己的明细与源扫描清单，并知道续传起点。
 */
export interface ToolContext {
  report(p: ProgressEvent): void
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: unknown): void
  signal: AbortSignal
  taskId: string
  /** 任务级目录（M0 = tasks 根目录，明细文件按 taskId 命名） */
  tempDir: string
  /** 仅 copy：源扫描明细所在目录 */
  sourceTaskDir?: string
  /** 续传起点：已完成项数（scan 为目录数，copy 为文件数） */
  resumeFrom?: number
}

export interface ScanContext extends ToolContext {
  appendDir(rec: DirRecord): void
  appendFile(rec: FileRecord): void
}

export interface ToolExecutor<S = unknown, C = unknown> {
  scan?(params: S, ctx: ScanContext): Promise<ScanResult>
  copy?(params: C, ctx: ToolContext): Promise<ToolResult>
}
