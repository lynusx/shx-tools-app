import type { DirRecord, FileRecord, ScanResult, ToolResult } from './tool-contract'

/** 主进程 → worker。一 worker 一任务，taskId 贯穿所有消息 */
export interface ScanCommand {
  taskId: string
  type: 'scan'
  toolId: string
  params: Record<string, unknown>
  taskDir: string
  resume: boolean
}

export interface CopyCommand {
  taskId: string
  type: 'copy'
  toolId: string
  params: Record<string, unknown>
  taskDir: string
  /** 源扫描的 taskId，复制任务的必填入参 */
  sourceScanId: string
  /**
   * 源扫描的明细目录。M0 约定：明细统一放在 tasks 根目录、按 taskId 命名，
   * 因此这里与 taskDir 相同；协议原文未列该字段，属于实现补充。
   */
  sourceTaskDir?: string
  /** 续传起点：主进程按上次进度写进命令（协议原文只规定了 scan 从日志重建） */
  resumeFrom?: number
  resume: boolean
}

export interface CancelCommand {
  taskId: string
  type: 'cancel'
}

export interface ResendCommand {
  taskId: string
  type: 'resend'
  stream: 'dirs' | 'files'
  fromSeq: number
}

export interface PingCommand {
  taskId: string
  type: 'ping'
}

export type WorkerCommand = ScanCommand | CopyCommand | CancelCommand | ResendCommand | PingCommand

export interface ProgressMessage {
  taskId: string
  type: 'progress'
  done: number
  total: number
  phase: 'scanning' | 'preparing' | 'copying'
  message?: string
  current?: string
  metrics?: Record<string, number | string>
}

export interface DirsMessage {
  taskId: string
  type: 'dirs'
  seq: number
  rows: DirRecord[]
}

export interface FilesMessage {
  taskId: string
  type: 'files'
  seq: number
  rows: FileRecord[]
}

export interface LogMessage {
  taskId: string
  type: 'log'
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  ts: number
}

export interface ResultMessage {
  taskId: string
  type: 'result'
  data: ScanResult | ToolResult
}

export interface ErrorMessage {
  taskId: string
  type: 'error'
  code: string
  message: string
  stack?: string
}

export interface PongMessage {
  taskId: string
  type: 'pong'
}

export type WorkerMessage =
  | ProgressMessage
  | DirsMessage
  | FilesMessage
  | LogMessage
  | ResultMessage
  | ErrorMessage
  | PongMessage
