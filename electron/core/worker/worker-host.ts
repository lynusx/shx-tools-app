import { app, utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import { join } from 'node:path'
import type { WorkerCommand, WorkerMessage } from '@shared/worker-protocol'

/**
 * 跨环境定位 worker 入口：
 * - 开发态：与 main/index.js 同在 out/main/
 * - 打包态：asar 内无法 fork，必须指向 app.asar.unpacked
 */
export function getWorkerEntryPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'worker.js')
  }
  return join(__dirname, 'worker.js')
}

export interface WorkerHostHandlers {
  onMessage(message: WorkerMessage): void
  onExit(code: number | null): void
  onTimeout(): void
}

const HEARTBEAT_MS = 5_000
const TIMEOUT_MS = 15_000

/** fork / kill / 消息编解码 / 心跳。一 worker 一任务，绝不复用进程 */
export class WorkerHost {
  private child: UtilityProcess | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private lastPong = 0
  private stopped = false

  start(command: WorkerCommand, handlers: WorkerHostHandlers): void {
    this.child = utilityProcess.fork(getWorkerEntryPath(), [], {
      serviceName: 'shx-tools-worker',
      stdio: 'pipe'
    })

    this.child.on('spawn', () => {
      this.lastPong = Date.now()
      this.child?.postMessage(command)
      this.startHeartbeat(handlers)
    })

    this.child.on('message', (message: WorkerMessage) => {
      if (message.type === 'pong') {
        this.lastPong = Date.now()
        return
      }
      handlers.onMessage(message)
    })

    this.child.on('exit', (code) => {
      this.stopHeartbeat()
      this.child = null
      if (!this.stopped) handlers.onExit(code)
    })
  }

  post(message: WorkerCommand): void {
    this.child?.postMessage(message)
  }

  kill(): void {
    this.stopped = true
    this.stopHeartbeat()
    this.child?.kill()
    this.child = null
  }

  private startHeartbeat(handlers: WorkerHostHandlers): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      if (!this.child) return
      if (Date.now() - this.lastPong > TIMEOUT_MS) {
        this.kill()
        handlers.onTimeout()
        return
      }
      // 心跳只带 taskId 之外没有语义，worker 回 pong 即可
      this.child.postMessage({ taskId: 'heartbeat', type: 'ping' } satisfies WorkerCommand)
    }, HEARTBEAT_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
  }
}
