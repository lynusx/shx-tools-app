import type { ToolManifest } from '@shared/tool-contract'

export const fakeManifest: ToolManifest = {
  id: 'fake',
  name: '假工具（M0 验证）',
  version: '0.1.0',
  description: '不碰真实文件，用来验证任务链路：扫描 → 明细落盘 → 复制 → 报告',
  category: 'utility',
  kinds: ['scan', 'copy'],
  ui: 'auto',
  paramsSchema: {
    scan: {
      type: 'object',
      properties: {
        dirs: { type: 'integer', title: '目录数', minimum: 1, maximum: 20000, default: 20 },
        filesPerDir: {
          type: 'integer',
          title: '每目录文件数',
          minimum: 0,
          maximum: 100,
          default: 5
        },
        delayMs: {
          type: 'integer',
          title: '每目录耗时(ms)',
          minimum: 0,
          maximum: 1000,
          default: 20
        }
      },
      required: ['dirs', 'filesPerDir']
    },
    copy: {
      type: 'object',
      properties: {
        sourceScanId: { type: 'string', title: '源扫描' },
        delayMs: { type: 'integer', title: '每文件耗时(ms)', minimum: 0, maximum: 1000, default: 5 }
      },
      required: ['sourceScanId']
    }
  }
}
