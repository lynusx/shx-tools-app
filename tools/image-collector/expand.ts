/**
 * 笛卡尔积展开：机台 → 时段 → 缺陷 → 等级，直接物化成可访问的完整路径。
 *
 * 顺序固定为「机台 → 日期 → 班次 → 时段 → 缺陷 → 等级」：同一机台的目录连续，
 * 避免在多个 UNC 主机之间来回切换（SMB 会话建立是秒级开销，顺序错了整体能慢一倍）。
 *
 * 参考：《F1 图片收集设计》§2.9。
 */

import {
  PRODUCTS,
  TemplateError,
  formatDate,
  renderTemplate,
  validatePath,
  type ProductConfig,
  type ProductType
} from './template'

export const MAX_SCAN_UNITS = 20_000

export interface MachineTarget {
  /** 机台编码，如 6B / B04-A */
  code: string
  /** 机台根，逐台不同；形态 A 来自 .lnk，形态 B 由入口 + 目录名拼出 */
  root: string
}

export interface ExpandParams {
  productType: ProductType
  machines: readonly MachineTarget[]
  /** YYYY-MM-DD */
  date: string
  shift: string
  /** 该班次的小时字面值，必须来自 PRODUCTS[type].shifts[shift] */
  hourSlots: readonly string[]
  defects: readonly string[]
  /** 仅力禧特：入口扫描已确定 SaveImages / el */
  subDir?: string
}

export interface ScanUnit {
  /** 已渲染的完整路径，可直接 opendir */
  path: string
  /** 前缀组键：到班次一级 */
  probePath: string
  /** 各字段取值，随明细落盘，报告分组不用再解析路径 */
  combo: Record<string, string>
}

export type ExpandErrorCode = 'E_PARAM' | 'E_LIMIT' | 'E_TEMPLATE'

export class ExpandError extends Error {
  readonly code: ExpandErrorCode

  constructor(code: ExpandErrorCode, message: string) {
    super(message)
    this.name = 'ExpandError'
    this.code = code
  }
}

interface ResolvedParams {
  config: ProductConfig
  hours: readonly string[]
  grades: readonly string[]
  subDir?: string
  dateText: string
}

function resolve(params: ExpandParams): ResolvedParams {
  const config = PRODUCTS[params.productType]
  if (!config) {
    throw new ExpandError('E_PARAM', `未知产品类型：${String(params.productType)}`)
  }

  const hours = config.shifts[params.shift]
  if (!hours) {
    throw new ExpandError(
      'E_PARAM',
      `班次「${params.shift}」不在 ${config.name} 的配置里（可选：${Object.keys(config.shifts).join(' / ')}）`
    )
  }

  if (params.machines.length === 0) throw new ExpandError('E_PARAM', '至少选择一台机台')
  if (params.defects.length === 0) throw new ExpandError('E_PARAM', '至少填写一个不良类型')
  if (params.hourSlots.length === 0) throw new ExpandError('E_PARAM', '至少选择一个时段')

  for (const hour of params.hourSlots) {
    if (!hours.includes(hour)) {
      throw new ExpandError('E_PARAM', `时段「${hour}」不属于 ${params.shift}`)
    }
  }

  let subDir: string | undefined
  if (config.subDirValues) {
    subDir = params.subDir
    if (!subDir) {
      throw new ExpandError('E_PARAM', `${config.name} 需要先确定子目录（SaveImages / el）`)
    }
    if (!config.subDirValues.includes(subDir)) {
      throw new ExpandError('E_PARAM', `子目录「${subDir}」不在 ${config.name} 的可选值里`)
    }
  }

  return {
    config,
    hours,
    grades: config.gradeValues ?? [],
    subDir,
    dateText: formatDate(params.date, config.dateFormat)
  }
}

/** 组合数 = 机台 × 时段 × 缺陷 × 等级；日期、班次单选，不参与乘积 */
export function countScanUnits(params: ExpandParams): number {
  const resolved = resolve(params)
  const grades = resolved.grades.length > 0 ? resolved.grades.length : 1
  return params.machines.length * params.hourSlots.length * params.defects.length * grades
}

export function expandScanUnits(params: ExpandParams): ScanUnit[] {
  const resolved = resolve(params)
  const total = countScanUnits(params)
  if (total > MAX_SCAN_UNITS) {
    throw new ExpandError(
      'E_LIMIT',
      `组合数 ${total} 超过上限 ${MAX_SCAN_UNITS}，请缩小机台或时段范围`
    )
  }

  const { config, grades, subDir, dateText } = resolved
  const units: ScanUnit[] = []

  for (const machine of params.machines) {
    const root = machine.root.replace(/[\\/]+$/, '')
    if (!root) {
      throw new ExpandError('E_PARAM', `机台 ${machine.code} 的根路径为空`)
    }

    const base: Record<string, string> = {
      machineRoot: root,
      machine: machine.code,
      machineLower: machine.code.toLowerCase(),
      date: params.date,
      shift: params.shift
    }
    if (subDir) base['subDir'] = subDir

    const probePath = render(config.probePattern, base)

    for (const hour of params.hourSlots) {
      for (const defect of params.defects) {
        const gradesForUnit = grades.length > 0 ? grades : [undefined]
        for (const grade of gradesForUnit) {
          const values: Record<string, string> = { ...base, hour, defect }
          if (grade) values['grade'] = grade

          const combo: Record<string, string> = {
            machine: machine.code,
            date: dateText,
            shift: params.shift,
            hour,
            defect
          }
          if (subDir) combo['subDir'] = subDir
          if (grade) combo['grade'] = grade

          units.push({ path: render(config.pattern, values), probePath, combo })
        }
      }
    }
  }

  return units
}

function render(pattern: string, values: Record<string, string>): string {
  try {
    const path = renderTemplate(pattern, values)
    validatePath(path)
    return path
  } catch (error) {
    if (error instanceof TemplateError) {
      const code = error.code === 'E_PARAM' ? 'E_PARAM' : 'E_TEMPLATE'
      throw new ExpandError(code, error.message)
    }
    throw error
  }
}
