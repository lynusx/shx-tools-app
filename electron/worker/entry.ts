import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ERROR_CODES } from '@shared/errors'
import type { DirRecord, FileRecord, ScanContext, ToolContext } from '@shared/tool-contract'
import type {
  ProgressMessage,
  ResendCommand,
  WorkerCommand,
  WorkerMessage
} from '@shared/worker-protocol'
import { getExecutor } from '@tools/index'

/**
 * utilityProcess 入口。
 *
 * 进程内不碰窗口与 IPC，只做三件事：接收命令、调用执行器、把事实回传。
 * 暂停由主进程直接 kill，所以这里没有 pause 分支——续跑靠磁盘日志。
 */
interface ParentPort {
  postMessage(message: WorkerMessage): void
  on(event: 'message', listener: (event: { data: WorkerCommand }) => void): void
}

const port = (process as unknown as { parentPort?: ParentPort }).parentPort

if (!port) {
  throw new Error('worker 只应通过 utilityProcess.fork 启动')
}

let taskId = ''
let controller: AbortController | null = null

let pendingDirs: DirRecord[] = []
let pendingFiles: FileRecord[] = []
let seqDirs = 0
let seqFiles = 0
const sentDirs: DirRecord[][] = []
const sentFiles: FileRecord[][] = []

let pendingProgress: ProgressMessage | null = null
let progressTimer: NodeJS.Timeout | null = null
let flushTimer: NodeJS.Timeout | null = null

function post(message: WorkerMessage): void {
  port?.postMessage(message)
}

function scheduleProgress(message: ProgressMessage): void {
  pendingProgress = message
  if (progressTimer) return
  progressTimer = setTimeout(() => {
    progressTimer = null
    if (pendingProgress) {
      post(pendingProgress)
      pendingProgress = null
    }
  }, 100)
}

function flushAll(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (pendingFiles.length > 0) {
    seqFiles += 1
    const rows = pendingFiles
    pendingFiles = []
    sentFiles[seqFiles - 1] = rows
    post({ taskId, type: 'files', seq: seqFiles, rows })
  }
  if (pendingDirs.length > 0) {
    seqDirs += 1
    const rows = pendingDirs
    pendingDirs = []
    sentDirs[seqDirs - 1] = rows
    post({ taskId, type: 'dirs', seq: seqDirs, rows })
  }
}

function flushIfNeeded(): void {
  if (pendingDirs.length >= 200 || pendingFiles.length >= 200) {
    flushAll()
    return
  }
  // 时间兜底：不攒够 200 条也要周期性落盘，否则暂停点会退回到 0
  if (!flushTimer) {
    flushTimer = setTimeout(flushAll, 200)
    flushTimer.unref?.()
  }
}

function resend(command: ResendCommand): void {
  if (command.stream === 'dirs') {
    for (let seq = command.fromSeq; seq <= sentDirs.length; seq += 1) {
      const rows = sentDirs[seq - 1]
      if (rows) post({ taskId, type: 'dirs', seq, rows })
    }
    return
  }
  for (let seq = command.fromSeq; seq <= sentFiles.length; seq += 1) {
    const rows = sentFiles[seq - 1]
    if (rows) post({ taskId, type: 'files', seq, rows })
  }
}

async function countLines(file: string): Promise<number> {
  const raw = await readFile(file, 'utf8').catch(() => '')
  return raw.split('\n').filter((line) => line.trim().length > 0).length
}

function reportProgress(message: ProgressMessage): void {
  scheduleProgress(message)
}

function logLine(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  meta?: unknown
): void {
  post({
    taskId,
    type: 'log',
    level,
    message: meta === undefined ? message : `${message} ${JSON.stringify(meta)}`,
    ts: Date.now()
  })
}

async function handle(command: WorkerCommand): Promise<void> {
  if (command.type === 'ping') {
    post({ taskId: command.taskId, type: 'pong' })
    return
  }
  if (command.type === 'cancel') {
    controller?.abort()
    return
  }
  if (command.type === 'resend') {
    resend(command)
    return
  }

  taskId = command.taskId
  controller = new AbortController()
  pendingDirs = []
  pendingFiles = []
  seqDirs = 0
  seqFiles = 0
  sentDirs.length = 0
  sentFiles.length = 0

  const executor = getExecutor(command.toolId)
  if (!executor) {
    post({
      taskId,
      type: 'error',
      code: ERROR_CODES.PARAM_INVALID,
      message: `未知工具：${command.toolId}`
    })
    return
  }

  try {
    if (command.type === 'scan') {
      const resumeFrom = command.resume
        ? await countLines(join(command.taskDir, `${taskId}.dirs.jsonl`))
        : 0
      const ctx: ScanContext = {
        taskId,
        tempDir: command.taskDir,
        signal: controller.signal,
        resumeFrom,
        report: reportProgress,
        log: logLine,
        appendDir: (record) => {
          pendingDirs.push(record)
          flushIfNeeded()
        },
        appendFile: (record) => {
          pendingFiles.push(record)
          flushIfNeeded()
        }
      }
      if (!executor.scan) throw new Error(`工具 ${command.toolId} 未实现 scan`)
      const result = await executor.scan(command.params, ctx)
      flushAll()
      post({ taskId, type: 'result', data: result })
      return
    }

    const ctx: ToolContext = {
      taskId,
      tempDir: command.taskDir,
      sourceTaskDir: command.sourceTaskDir,
      resumeFrom: command.resumeFrom ?? 0,
      signal: controller.signal,
      report: reportProgress,
      log: logLine
    }
    if (!executor.copy) throw new Error(`工具 ${command.toolId} 未实现 copy`)
    const result = await executor.copy(command.params, ctx)
    post({ taskId, type: 'result', data: result })
  } catch (error) {
    // 主进程取消时会直接 kill；这里不再回错误，避免把「已取消」写成「失败」
    if (controller.signal.aborted) return
    post({
      taskId,
      type: 'error',
      code: ERROR_CODES.UNKNOWN,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    })
  }
}

port.on('message', (event) => {
  void handle(event.data)
})
