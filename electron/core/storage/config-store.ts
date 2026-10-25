import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { writeJsonAtomic } from './atomic-write'

const configSchema = z.object({
  schemaVersion: z.literal(1),
  limits: z.object({
    globalTasks: z.number().int().min(1).max(4),
    perToolTasks: z.number().int().min(1).max(2)
  }),
  logLevel: z.enum(['debug', 'info', 'warn', 'error'])
})

export type AppConfig = z.infer<typeof configSchema>

export const DEFAULT_CONFIG: AppConfig = {
  schemaVersion: 1,
  limits: { globalTasks: 2, perToolTasks: 1 },
  logLevel: 'info'
}

/** config.json 是跨工具、跨会话配置的唯一权威 */
export class ConfigStore {
  private config: AppConfig = DEFAULT_CONFIG

  constructor(private readonly file: string) {}

  get current(): AppConfig {
    return this.config
  }

  async load(): Promise<AppConfig> {
    await mkdir(join(this.file, '..'), { recursive: true })
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = configSchema.safeParse(JSON.parse(raw))
      if (parsed.success) {
        this.config = parsed.data
      }
    } catch {
      // 首次启动或文件损坏：用默认值，并在下次 save 时覆盖
    }
    return this.config
  }

  async save(patch: Partial<AppConfig>): Promise<AppConfig> {
    const next = configSchema.parse({ ...this.config, ...patch })
    await writeJsonAtomic(this.file, next)
    this.config = next
    return next
  }
}
