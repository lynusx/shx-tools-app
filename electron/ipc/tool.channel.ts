import { IPC } from '@shared/ipc-channels'
import type { ToolRegistry } from '../core/tool-registry'
import { register } from './router'

export function registerToolChannels(tools: ToolRegistry): void {
  register(IPC.toolList, null, () => tools.list())
}
