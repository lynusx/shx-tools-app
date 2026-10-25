import type { TaskError } from './errors'
import type { CopySummary, ScanSummary, TaskKind, TaskPhase, ToolResult } from './tool-contract'

export type TaskState =
  | 'created'
  | 'preparing'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'interrupted'

export const TERMINAL_STATES = ['succeeded', 'failed', 'canceled'] as const
export const RESUMABLE_STATES = ['paused', 'interrupted'] as const

export type TaskSummary = ScanSummary | CopySummary | Record<string, number | string>

export interface ProgressSnapshot {
  done: number
  total: number
  phase?: TaskPhase
  current?: string
  metrics?: Record<string, number | string>
}

export interface TaskRecord {
  schemaVersion: number
  id: string
  toolId: string
  toolVersion: string
  kind: TaskKind
  state: TaskState
  resumable: boolean
  /** 参数是快照：模板改动、删除都不影响历史记录 */
  params: Record<string, unknown>
  sourceScanId?: string
  startedAt: string
  finishedAt: string | null
  activeMs: number
  progress?: ProgressSnapshot
  summary: TaskSummary
  dirsTruncated?: boolean
  filesTruncated?: boolean
  failures?: ToolResult['failures']
  artifacts?: ToolResult['artifacts']
  error?: TaskError
}

export interface TaskCreateInput {
  toolId: string
  kind: TaskKind
  params: Record<string, unknown>
}

export interface TaskListQuery {
  limit?: number
  offset?: number
  kind?: TaskKind
}

export interface TaskStateEvent {
  taskId: string
  state: TaskState
  resumable: boolean
  progress?: ProgressSnapshot
  error?: TaskError
}

export interface TaskProgressEvent {
  taskId: string
  phase: TaskPhase
  done: number
  total: number
  current?: string
  elapsedMs: number
  metrics?: Record<string, number | string>
}

export interface TaskLogEvent {
  taskId: string
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  ts: number
}

export interface Page<T> {
  rows: T[]
  total: number
  truncated: boolean
}
