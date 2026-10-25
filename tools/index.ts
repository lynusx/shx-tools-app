import type { ToolExecutor } from '@shared/tool-contract'
import { fakeExecutor } from './fake/executor'
import { fakeManifest } from './fake/manifest'

/**
 * 静态注册表：构建期打包进 worker。
 * 不做运行时动态加载——工具数量有限，类型安全优于灵活性。
 */
const EXECUTORS: Record<string, ToolExecutor> = {
  [fakeManifest.id]: fakeExecutor
}

export function getExecutor(toolId: string): ToolExecutor | undefined {
  return EXECUTORS[toolId]
}
