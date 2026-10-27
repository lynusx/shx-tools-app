import type { ToolManifest } from '@shared/tool-contract'

/** 主进程只读元数据；执行器在 worker 侧 */
export const imageCollectorManifest: ToolManifest = {
  id: 'image-collector',
  name: '图片收集',
  version: '0.1.0',
  description: '按机台 × 日期 × 班次 × 时段 × 不良类型收集产线图片目录',
  category: 'file',
  kinds: ['scan'],
  ui: 'custom',
  icon: 'FolderOpenOutlined',
  paramsSchema: {
    scan: {
      type: 'object',
      properties: {
        entryPath: { type: 'string', title: '入口路径' },
        entryForm: { type: 'string', enum: ['shortcut', 'direct'], default: 'shortcut' },
        productType: { type: 'string', enum: ['lipo', 'lixite', 'el'], title: '产品类型' },
        machines: {
          type: 'array',
          title: '机台',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              region: { type: 'string' },
              root: { type: 'string' }
            },
            required: ['code', 'region', 'root']
          }
        },
        date: { type: 'string', title: '日期', description: 'YYYY-MM-DD' },
        shift: { type: 'string', title: '班次' },
        hourSlots: { type: 'array', items: { type: 'string' }, title: '时段' },
        defects: { type: 'array', items: { type: 'string' }, title: '不良类型' },
        extensions: { type: 'array', items: { type: 'string' }, default: ['jpg', 'png', 'bmp'] },
        dedupe: { type: 'boolean', default: false },
        subDir: { type: 'string', title: '子目录', description: '仅力禧特：SaveImages / el' }
      },
      required: ['productType', 'machines', 'date', 'shift', 'defects']
    }
  }
}
