/**
 * 信号量并发池：只允许指定数量的任务同时通过。
 * 需求很小（40 行），不引第三方依赖，且取消时能把排队项一次清空。
 */
export class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []
  private limit: number

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit))
  }

  get running(): number {
    return this.active
  }

  get queued(): number {
    return this.waiters.length
  }

  setLimit(limit: number): void {
    this.limit = Math.max(1, Math.floor(limit))
    this.drain()
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1
      return this.releaser()
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.active += 1
    return this.releaser()
  }

  /** 清空排队者（应用退出 / 取消全部任务时用） */
  clear(): void {
    const waiters = this.waiters.splice(0)
    for (const resolve of waiters) resolve()
    this.active = Math.min(this.active, this.limit)
  }

  private releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active = Math.max(0, this.active - 1)
      this.drain()
    }
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const next = this.waiters.shift()
      if (next) next()
    }
  }
}
