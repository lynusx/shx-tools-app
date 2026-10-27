import type { ToolExecutor } from '@shared/tool-contract'
import { scanImageCollector } from './scan'

/** F1 图片收集：先交付扫描；复制在下一步接入 */
export const imageCollectorExecutor: ToolExecutor = {
  scan: scanImageCollector
}
