/**
 * F1 产品路径模板：三类产品的目录结构、班次时段字面值、日期格式都放在这里。
 *
 * 模板是路径的唯一事实来源——展开、前缀探测、报告都从同一份 pattern 渲染，
 * 不允许在别处二次拼接。改现场目录结构时改这里，不改调用方。
 *
 * 参考：《F1 图片收集设计》§2.2 / §2.6。
 */

export type ProductType = 'lipo' | 'lixite' | 'el'

export interface ProductConfig {
  name: string
  /** 完整路径模板 */
  pattern: string
  /** 前缀探测模板：到班次一级，用于 3.5 的分组预检 */
  probePattern: string
  /** 日期格式；同时决定 {date:FORMAT} 的默认写法 */
  dateFormat: string
  /** 班次 → 小时字面值。不能统一补零/去零，必须按目录字面值抄 */
  shifts: Readonly<Record<string, readonly string[]>>
  /** 仅利珀；没有该字段的产品，模板里也不出现 {grade} */
  gradeValues?: readonly string[]
  /** 仅力禧特；展开时必须由入口扫描结果提供 */
  subDirValues?: readonly string[]
  /** 仅形态 B（EL）；一级子目录的机台名匹配规则 */
  machineNamePatterns?: readonly string[]
}

export const PRODUCTS: Record<ProductType, ProductConfig> = {
  lipo: {
    name: '利珀',
    pattern:
      '{machineRoot}\\pl-{machineLower}\\Matting\\{date:YYYY.MM.DD}\\{machine}\\{shift}\\{hour}\\Fail\\{grade}\\{defect}',
    probePattern:
      '{machineRoot}\\pl-{machineLower}\\Matting\\{date:YYYY.MM.DD}\\{machine}\\{shift}',
    gradeValues: ['A', 'B', 'C'],
    dateFormat: 'YYYY.MM.DD',
    shifts: {
      白班: ['08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19'],
      夜班: ['20', '21', '22', '23', '00', '01', '02', '03', '04', '05', '06', '07']
    }
  },
  lixite: {
    name: '力禧特',
    pattern: '{machineRoot}\\{subDir}\\A-01-B\\{date:YYYYMMDD}\\{shift}\\{hour}\\{defect}',
    probePattern: '{machineRoot}\\{subDir}\\A-01-B\\{date:YYYYMMDD}\\{shift}',
    subDirValues: ['SaveImages', 'el'],
    dateFormat: 'YYYYMMDD',
    shifts: {
      白班: ['8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19'],
      夜班: ['20', '21', '22', '23', '0', '1', '2', '3', '4', '5', '6', '7']
    }
  },
  el: {
    name: 'EL',
    pattern: '{machineRoot}\\EL\\{date:YYYYMMDD}\\{shift}\\{hour}\\{defect}',
    probePattern: '{machineRoot}\\EL\\{date:YYYYMMDD}\\{shift}',
    dateFormat: 'YYYYMMDD',
    machineNamePatterns: ['^[AB]\\d{2}-[AB]$', '^[AB]-LXJC-\\d{2}$'],
    shifts: {
      白班: ['8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19'],
      夜班: ['20', '21', '22', '23', '0', '1', '2', '3', '4', '5', '6', '7']
    }
  }
}

export type TemplateErrorCode = 'E_TEMPLATE_INVALID' | 'E_PARAM'

export class TemplateError extends Error {
  readonly code: TemplateErrorCode

  constructor(code: TemplateErrorCode, message: string) {
    super(message)
    this.name = 'TemplateError'
    this.code = code
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)(?::([^}]+))?\}/g

/** YYYY-MM-DD → 模板要求的格式；只认 YYYY / MM / DD 三个 token */
export function formatDate(isoDate: string, format: string): string {
  const match = ISO_DATE.exec(isoDate)
  if (!match) {
    throw new TemplateError('E_PARAM', `日期必须是 YYYY-MM-DD：${isoDate}`)
  }
  const [, year, month, day] = match
  return format.replace(/YYYY|MM|DD/g, (token) => {
    if (token === 'YYYY') return year ?? ''
    if (token === 'MM') return month ?? ''
    return day ?? ''
  })
}

/** 渲染契约：输出必须是完整路径；残留占位符、缺字段都视为模板错误 */
export function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  const rendered = template.replace(PLACEHOLDER, (_match, key: string, format?: string) => {
    if (key === 'date' && format) {
      const isoDate = values['date']
      if (!isoDate)
        throw new TemplateError('E_TEMPLATE_INVALID', '模板用到了 {date}，但没有传入日期')
      return formatDate(isoDate, format)
    }
    const value = values[key]
    if (value === undefined) {
      throw new TemplateError('E_TEMPLATE_INVALID', `模板字段缺失：{${key}}`)
    }
    return value
  })

  if (/\{[^}]+\}/.test(rendered)) {
    throw new TemplateError('E_TEMPLATE_INVALID', `渲染后仍残留占位符：${rendered}`)
  }
  return rendered
}

/** 输出后格式校验：UNC / 盘符开头、无重复分隔符、无 ..、无占位符 */
export function validatePath(path: string): void {
  const isUnc = path.startsWith('\\\\')
  const isDrive = /^[A-Za-z]:\\/.test(path)
  if (!isUnc && !isDrive) {
    throw new TemplateError('E_TEMPLATE_INVALID', `路径必须以 UNC 或盘符开头：${path}`)
  }
  if (/\{[^}]+\}/.test(path)) {
    throw new TemplateError('E_TEMPLATE_INVALID', `路径残留占位符：${path}`)
  }
  const rest = isUnc ? path.slice(2) : path.slice(3)
  if (rest.includes('//') || rest.includes('\\\\')) {
    throw new TemplateError('E_TEMPLATE_INVALID', `路径含重复分隔符：${path}`)
  }
  if (path.split(/[\\/]/).includes('..')) {
    throw new TemplateError('E_TEMPLATE_INVALID', `路径不得包含 ..：${path}`)
  }
}
