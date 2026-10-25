import type { ToolManifest } from '@shared/tool-contract'
import { fakeManifest } from './fake/manifest'

/**
 * 主进程只需要元数据，不导入执行器——执行器里可能有 fs/重依赖，
 * 让它们只进 worker 的包里。
 */
export const TOOL_MANIFESTS: ToolManifest[] = [fakeManifest]
