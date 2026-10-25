import { EventEmitter } from 'node:events'
import type { DirRecord, FileRecord, ScanResult, TaskKind, ToolResult } from '@shared/tool-contract'
import type { WorkerMessage } from '@shared/worker-protocol'
import type {
  Page,
  TaskCreateInput,
  TaskListQuery,
  TaskProgressEvent,
  TaskRecord,
  TaskState,
  TaskStateEvent,
  TaskSummary
} from '@shared/task'
import { ERROR_CODES, makeTaskError, type ErrorCode, type TaskError } from '@shared/errors'
import { Semaphore } from '@infra/limit'
import type { ToolRegistry } from '../tool-registry'
import type { Logger } from '../logger'
import type { ConfigStore } from '../storage/config-store'
import { isResumable, isTerminal, assertTransition } from './task-state'
import type { TaskStore } from './task-store'
import { WorkerHost } from '../worker/worker-host'

interface RunningTask {
  host: WorkerHost
  release: () => void
  startedAt: number
  appendChain: Promise<void>
}

const ACTIVE_STATES: TaskState[] = ['created', 'preparing', 'running']

/**
 * 任务状态的唯一写入口：worker 只上报事实，迁移、落盘、广播都在这里。
 */
export class TaskManager extends EventEmitter {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly running = new Map<string, RunningTask>()
  private readonly toolPools = new Map<string, Semaphore>()
  private readonly saveTimers = new Map<string, NodeJS.Timeout>()
  private readonly globalPool: Semaphore

  constructor(
    private readonly store: TaskStore,
    private readonly tools: ToolRegistry,
    private readonly config: ConfigStore,
    private readonly logger: Logger
  ) {
    super()
    this.globalPool = new Semaphore(config.current.limits.globalTasks)
  }

  async init(): Promise<void> {
    await this.store.init()
    for (const record of await this.store.list()) {
      // 上次退出时的运行中任务：补写 interrupted，保留可续
      if (ACTIVE_STATES.includes(record.state)) {
        record.state = 'interrupted'
        record.resumable = true
        record.finishedAt = null
        await this.store.save(record)
      }
      this.tasks.set(record.id, record)
    }
    await this.store.cleanup('scan')
    await this.store.cleanup('copy')
  }

  async create(input: TaskCreateInput): Promise<TaskRecord> {
    const tool = this.tools.find(input.toolId)
    if (!tool) throw new Error(`未知工具：${input.toolId}`)
    if (!tool.kinds.includes(input.kind))
      throw new Error(`工具 ${tool.id} 不支持 ${input.kind} 任务`)

    const record: TaskRecord = {
      schemaVersion: 1,
      id: newTaskId(),
      toolId: input.toolId,
      toolVersion: tool.version,
      kind: input.kind,
      state: 'created',
      resumable: false,
      params: input.params,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      activeMs: 0,
      summary: emptySummary(input.kind)
    }

    if (input.kind === 'copy') {
      const sourceScanId = input.params['sourceScanId']
      if (typeof sourceScanId !== 'string' || sourceScanId.length === 0) {
        throw new Error('复制任务缺少 sourceScanId')
      }
      record.sourceScanId = sourceScanId
    }

    this.tasks.set(record.id, record)
    await this.store.save(record)
    this.emitState(record)
    void this.start(record, false)
    return record
  }

  async pause(id: string): Promise<void> {
    const record = this.require(id)
    if (record.state !== 'preparing' && record.state !== 'running') {
      throw new Error(`当前状态不可暂停：${record.state}`)
    }
    const run = this.running.get(id)
    if (run) {
      this.running.delete(id)
      this.clearSaveTimer(id)
      record.activeMs += Date.now() - run.startedAt
      run.host.kill()
      run.release()
    }
    await this.transition(record, 'paused')
  }

  async resume(id: string): Promise<void> {
    const record = this.require(id)
    if (!isResumable(record.state)) throw new Error(`当前状态不可继续：${record.state}`)
    await this.transition(record, 'preparing', { resumable: false })
    void this.start(record, true)
  }

  async cancel(id: string): Promise<void> {
    const record = this.require(id)
    if (isTerminal(record.state)) throw new Error('任务已结束，不能取消')
    const run = this.running.get(id)
    if (run) {
      this.running.delete(id)
      this.clearSaveTimer(id)
      record.activeMs += Date.now() - run.startedAt
      run.host.kill()
      run.release()
    }
    await this.transition(record, 'canceled')
  }

  async remove(id: string): Promise<void> {
    const record = this.require(id)
    if (!isTerminal(record.state)) throw new Error('仅终态任务可删除，请先取消')
    this.tasks.delete(id)
    await this.store.remove(id)
  }

  get(id: string): TaskRecord {
    return this.require(id)
  }

  list(query: TaskListQuery = {}): TaskRecord[] {
    const rows = [...this.tasks.values()]
      .filter((record) => (query.kind ? record.kind === query.kind : true))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    const offset = query.offset ?? 0
    const limit = query.limit ?? 100
    return rows.slice(offset, offset + limit)
  }

  latestScan(toolId: string): TaskRecord | null {
    const scans = [...this.tasks.values()]
      .filter(
        (record) =>
          record.toolId === toolId && record.kind === 'scan' && record.state === 'succeeded'
      )
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    return scans[0] ?? null
  }

  dirs(id: string, offset?: number, limit?: number): Promise<Page<DirRecord>> {
    return this.store.readDirs(id, offset, limit)
  }

  files(id: string, offset?: number, limit?: number): Promise<Page<FileRecord>> {
    return this.store.readFiles(id, offset, limit)
  }

  private async start(record: TaskRecord, resume: boolean): Promise<void> {
    if (record.state !== 'preparing') {
      await this.transition(record, 'preparing')
    }
    const release = await this.acquire(record.toolId)
    const latest = this.tasks.get(record.id)
    if (!latest || latest.state !== 'preparing') {
      release()
      return
    }

    const host = new WorkerHost()
    const run: RunningTask = {
      host,
      release,
      startedAt: Date.now(),
      appendChain: Promise.resolve()
    }
    this.running.set(record.id, run)

    host.start(this.buildCommand(record, resume), {
      onMessage: (message) => this.handleMessage(record, run, message),
      onExit: (code) => void this.handleExit(record, run, code),
      onTimeout: () =>
        void this.fail(record, run, {
          code: ERROR_CODES.WORKER_TIMEOUT,
          message: 'worker 15 秒无响应，已强制结束'
        })
    })
  }

  private buildCommand(record: TaskRecord, resume: boolean): Parameters<WorkerHost['start']>[0] {
    const base = {
      taskId: record.id,
      toolId: record.toolId,
      params: record.params,
      taskDir: this.store.root,
      resume
    }
    if (record.kind === 'scan') {
      return { ...base, type: 'scan' }
    }
    if (!record.sourceScanId) {
      throw new Error('复制任务缺少 sourceScanId')
    }
    return {
      ...base,
      type: 'copy',
      sourceScanId: record.sourceScanId,
      sourceTaskDir: this.store.root,
      resumeFrom: record.progress?.done ?? 0
    }
  }

  private handleMessage(record: TaskRecord, run: RunningTask, message: WorkerMessage): void {
    switch (message.type) {
      case 'progress': {
        record.progress = {
          done: message.done,
          total: message.total,
          phase: message.phase,
          current: message.current,
          metrics: message.metrics
        }
        const event: TaskProgressEvent = {
          taskId: record.id,
          phase: message.phase,
          done: message.done,
          total: message.total,
          current: message.current,
          elapsedMs: record.activeMs + (Date.now() - run.startedAt),
          metrics: message.metrics
        }
        this.emit('progress', event)
        this.scheduleSave(record)
        break
      }
      case 'dirs': {
        const rows = message.rows
        run.appendChain = run.appendChain
          .then(() => this.store.appendDirs(record.id, rows))
          .catch((error: unknown) =>
            this.logger.warn('目录明细写入失败', { id: record.id, error: String(error) })
          )
        break
      }
      case 'files': {
        const rows = message.rows
        run.appendChain = run.appendChain
          .then(() => this.store.appendFiles(record.id, rows))
          .catch((error: unknown) =>
            this.logger.warn('文件清单写入失败', { id: record.id, error: String(error) })
          )
        break
      }
      case 'log': {
        this.logger[message.level](`[task ${record.id}] ${message.message}`)
        this.emit('log', {
          taskId: record.id,
          level: message.level,
          message: message.message,
          ts: message.ts
        })
        break
      }
      case 'result': {
        void this.succeed(record, run, message.data)
        break
      }
      case 'error': {
        void this.fail(record, run, {
          code: message.code as ErrorCode,
          message: message.message,
          stack: message.stack
        })
        break
      }
      default:
        break
    }
  }

  private async succeed(
    record: TaskRecord,
    run: RunningTask,
    data: ScanResult | ToolResult
  ): Promise<void> {
    if (this.running.get(record.id) !== run) return
    await run.appendChain
    this.finishRunning(record, run)

    if (record.kind === 'scan') {
      record.summary = (data as ScanResult).summary
    } else {
      const result = data as ToolResult
      record.summary = result.summary
      record.failures = result.failures
      record.artifacts = result.artifacts
    }
    await this.transition(record, 'succeeded')
  }

  private async fail(record: TaskRecord, run: RunningTask, error: TaskError): Promise<void> {
    if (this.running.get(record.id) !== run) return
    await run.appendChain
    this.finishRunning(record, run)
    record.error = error
    await this.transition(record, 'failed')
  }

  private async handleExit(
    record: TaskRecord,
    run: RunningTask,
    code: number | null
  ): Promise<void> {
    if (this.running.get(record.id) !== run) return
    this.finishRunning(record, run)
    record.error = {
      code: ERROR_CODES.WORKER_CRASH,
      message: `worker 异常退出（code=${code === null ? 'null' : code}）`
    }
    await this.transition(record, 'failed')
  }

  private finishRunning(record: TaskRecord, run: RunningTask): void {
    this.running.delete(record.id)
    this.clearSaveTimer(record.id)
    record.activeMs += Date.now() - run.startedAt
    run.release()
    // 任务终态后 5 秒回收进程（协议约定）；先留时间把日志刷完
    const timer = setTimeout(() => run.host.kill(), 5_000)
    timer.unref?.()
  }

  private transition(
    record: TaskRecord,
    next: TaskState,
    patch: Partial<TaskRecord> = {}
  ): Promise<void> {
    assertTransition(record.state, next)
    Object.assign(record, patch)
    record.state = next
    record.resumable = isResumable(next)
    record.finishedAt = isTerminal(next) ? new Date().toISOString() : null
    return this.persist(record)
  }

  private async persist(record: TaskRecord): Promise<void> {
    try {
      await this.store.save(record)
    } catch (error) {
      // 写失败不阻断任务：记录在内存里，UI 仍能工作
      this.logger.error('任务记录写入失败', { id: record.id, error: String(error) })
    }
    this.emitState(record)
  }

  private emitState(record: TaskRecord): void {
    const event: TaskStateEvent = {
      taskId: record.id,
      state: record.state,
      resumable: record.resumable,
      progress: record.progress,
      error: record.error
    }
    this.emit('state', event)
  }

  private scheduleSave(record: TaskRecord): void {
    if (this.saveTimers.has(record.id)) return
    const timer = setTimeout(() => {
      this.saveTimers.delete(record.id)
      void this.store.save(record).catch((error: unknown) => {
        this.logger.warn('运行中指标写入失败', { id: record.id, error: String(error) })
      })
    }, 2_000)
    timer.unref?.()
    this.saveTimers.set(record.id, timer)
  }

  private clearSaveTimer(id: string): void {
    const timer = this.saveTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.saveTimers.delete(id)
    }
  }

  private async acquire(toolId: string): Promise<() => void> {
    const perTool = this.poolFor(toolId)
    const releaseGlobal = await this.globalPool.acquire()
    const releaseTool = await perTool.acquire()
    return () => {
      releaseTool()
      releaseGlobal()
    }
  }

  private poolFor(toolId: string): Semaphore {
    let pool = this.toolPools.get(toolId)
    if (!pool) {
      pool = new Semaphore(this.config.current.limits.perToolTasks)
      this.toolPools.set(toolId, pool)
    }
    return pool
  }

  private require(id: string): TaskRecord {
    const record = this.tasks.get(id)
    if (!record) throw new Error(`任务不存在：${id}`)
    return record
  }
}

function emptySummary(kind: TaskKind): TaskSummary {
  if (kind === 'scan') {
    return {
      dirCount: 0,
      fileCount: 0,
      bytes: 0,
      byStatus: { ok: 0, empty: 0, missing: 0, unreachable: 0, denied: 0, error: 0 }
    }
  }
  return {
    planned: { fileCount: 0, bytes: 0 },
    copied: { fileCount: 0, bytes: 0 },
    conflict: { renamed: 0, overwritten: 0, skippedExisting: 0 },
    skippedDuplicate: 0,
    adopted: 0,
    failed: { fileCount: 0 }
  }
}

function newTaskId(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${stamp}-${Math.random().toString(16).slice(2, 6)}`
}

// 让类型检查知道 makeTaskError 仍被导出侧使用（M0 错误归一化入口）
export { makeTaskError }
