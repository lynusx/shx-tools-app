import { z } from 'zod'

/**
 * F1 图片收集 · 扫描参数。
 * 机台根由入口扫描（.lnk 解析或目录拼接）得到，任务创建时随参数快照落盘。
 */
export const imageScanParams = z.object({
  entryPath: z.string().default(''),
  entryForm: z.enum(['shortcut', 'direct']).default('shortcut'),
  productType: z.enum(['lipo', 'lixite', 'el']),
  machines: z
    .array(
      z.object({
        code: z.string().min(1),
        region: z.string().min(1),
        root: z.string().min(1)
      })
    )
    .min(1),
  /** YYYY-MM-DD */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  shift: z.string().min(1),
  /** 留空表示该班次全部小时 */
  hourSlots: z.array(z.string()).default([]),
  defects: z.array(z.string().min(1)).min(1),
  extensions: z.array(z.string()).default(['jpg', 'png', 'bmp']),
  dedupe: z.boolean().default(false),
  /** 仅力禧特 */
  subDir: z.string().optional()
})

export type ImageScanParams = z.infer<typeof imageScanParams>
