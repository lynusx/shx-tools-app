import type { ToolManifest } from '@shared/tool-contract'

/** 主进程侧的工具清单：只读元数据，不加载执行器 */
export class ToolRegistry {
  constructor(private readonly manifests: ToolManifest[]) {}

  list(): ToolManifest[] {
    return this.manifests
  }

  find(toolId: string): ToolManifest | undefined {
    return this.manifests.find((manifest) => manifest.id === toolId)
  }
}
