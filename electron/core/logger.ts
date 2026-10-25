import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** 路径脱敏：只保留盘符与层级，不把用户完整路径写进日志 */
export function maskPath(path: string): string {
  return path.replace(/([A-Za-z]:)\\[^\\]+/g, '$1\\***')
}

export class Logger {
  private level: LogLevel

  constructor(
    private readonly dir: string,
    level: LogLevel = 'info'
  ) {
    this.level = level
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  setLevel(level: LogLevel): void {
    this.level = level
  }

  debug(message: string, meta?: unknown): void {
    this.write('debug', message, meta)
  }

  info(message: string, meta?: unknown): void {
    this.write('info', message, meta)
  }

  warn(message: string, meta?: unknown): void {
    this.write('warn', message, meta)
  }

  error(message: string, meta?: unknown): void {
    this.write('error', message, meta)
  }

  private write(level: LogLevel, message: string, meta?: unknown): void {
    if (ORDER[level] < ORDER[this.level]) return
    const ts = new Date().toISOString()
    const suffix = meta === undefined ? '' : ` ${safeJson(meta)}`
    const line = `${ts} [${level.toUpperCase()}] ${message}${suffix}\n`
    if (level === 'error') console.error(line.trimEnd())
    else console.log(line.trimEnd())
    const file = join(this.dir, `app-${ts.slice(0, 10)}.log`)
    void appendFile(file, line).catch(() => undefined)
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable]'
  }
}
