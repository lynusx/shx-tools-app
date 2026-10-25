import { ipcMain } from 'electron'
import type { ZodType } from 'zod'

/**
 * 统一注册：zod 校验入参，异常原样抛回渲染进程（ipcMain.handle 会把 Error 序列化过去）。
 */
export function register<Input, Output>(
  channel: string,
  schema: ZodType<Input> | null,
  handler: (input: Input) => Output | Promise<Output>
): void {
  ipcMain.handle(channel, async (_event, raw: unknown) => {
    const input = schema ? schema.parse(raw) : (raw as Input)
    return handler(input)
  })
}
