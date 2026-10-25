import { z } from 'zod'

/** 假工具的入参：只用来验证链路，不碰真实文件 */
export const fakeScanParams = z.object({
  dirs: z.number().int().min(1).max(20_000),
  filesPerDir: z.number().int().min(0).max(100),
  delayMs: z.number().int().min(0).max(1_000).default(20)
})

export type FakeScanParams = z.infer<typeof fakeScanParams>

export const fakeCopyParams = z.object({
  sourceScanId: z.string().min(1),
  delayMs: z.number().int().min(0).max(1_000).default(5)
})

export type FakeCopyParams = z.infer<typeof fakeCopyParams>
