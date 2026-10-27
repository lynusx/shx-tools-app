/**
 * 输出落点：扫描阶段一次算好，复制阶段只把目标根拼在前面。
 *
 * 骨架（分层模式）：`日期\区域\机台\缺陷\时段\等级\文件名`
 * 力禧特 / EL 没有等级层，直接省略，不生成空的 A\ 目录。
 *
 * 参考：《F1 图片收集设计》§4.3。
 */

import type { ProductType } from './template'

export interface DestCombo {
  date?: string
  region?: string
  machine?: string
  defect?: string
  hour?: string
  grade?: string
}

export class LayoutError extends Error {
  readonly code = 'E_LAYOUT'

  constructor(message: string) {
    super(message)
    this.name = 'LayoutError'
  }
}

/**
 * 利珀的输出日期按示例固定用 `YYYY-MM-DD`（源目录是 `YYYY.MM.DD`），
 * 力禧特 / EL 沿用源字面值 `YYYYMMDD`。见 F1 §4.3 的三行示例。
 */
function destDate(productType: ProductType, date: string): string {
  return productType === 'lipo' ? date.replaceAll('.', '-') : date
}

export function buildDest(productType: ProductType, combo: DestCombo, fileName: string): string {
  const { date, region, machine, defect, hour, grade } = combo
  if (!date) throw new LayoutError('缺少日期，无法计算输出落点')
  if (!region) throw new LayoutError('缺少区域，无法计算输出落点')
  if (!machine) throw new LayoutError('缺少机台，无法计算输出落点')
  if (!defect) throw new LayoutError('缺少不良类型，无法计算输出落点')
  if (!hour) throw new LayoutError('缺少时段，无法计算输出落点')

  const parts = [destDate(productType, date), region, machine, defect, hour]
  if (productType === 'lipo') {
    if (!grade) throw new LayoutError('利珀缺少等级，无法计算输出落点')
    parts.push(grade)
  }
  parts.push(fileName)
  return parts.join('\\')
}
