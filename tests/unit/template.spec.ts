import { describe, expect, it } from 'vitest'
import {
  PRODUCTS,
  TemplateError,
  formatDate,
  renderTemplate,
  validatePath
} from '@tools/image-collector/template'

describe('formatDate', () => {
  it('按产品格式输出日期', () => {
    expect(formatDate('2026-10-23', 'YYYY.MM.DD')).toBe('2026.10.23')
    expect(formatDate('2026-10-23', 'YYYYMMDD')).toBe('20261023')
  })

  it('非法日期报 E_PARAM', () => {
    expect(() => formatDate('2026/10/23', 'YYYYMMDD')).toThrow(TemplateError)
  })
})

describe('renderTemplate', () => {
  it('渲染利珀完整路径', () => {
    const path = renderTemplate(PRODUCTS.lipo.pattern, {
      machineRoot: '\\\\10.108.9.153',
      machine: '6B',
      machineLower: '6b',
      date: '2026-10-23',
      shift: '白班',
      hour: '13',
      grade: 'A',
      defect: '明暗片'
    })

    expect(path).toBe('\\\\10.108.9.153\\pl-6b\\Matting\\2026.10.23\\6B\\白班\\13\\Fail\\A\\明暗片')
  })

  it('{hour} 用字面值，不补零也不去零', () => {
    const lixite = renderTemplate(PRODUCTS.lixite.pattern, {
      machineRoot: '\\\\10.108.8.232',
      subDir: 'SaveImages',
      date: '2026-10-23',
      shift: '白班',
      hour: '8',
      defect: 'NG_连续性断栅_A-'
    })
    const lipo = renderTemplate(PRODUCTS.lipo.pattern, {
      machineRoot: '\\\\10.108.9.153',
      machine: '6B',
      machineLower: '6b',
      date: '2026-10-23',
      shift: '白班',
      hour: '08',
      grade: 'A',
      defect: '明暗片'
    })

    expect(lixite).toContain('\\白班\\8\\')
    expect(lipo).toContain('\\白班\\08\\')
  })

  it('缺字段时直接报错，不产出带占位符的路径', () => {
    expect(() =>
      renderTemplate(PRODUCTS.lipo.pattern, {
        machineRoot: '\\\\10.108.9.153',
        machine: '6B',
        machineLower: '6b',
        date: '2026-10-23',
        shift: '白班',
        hour: '13',
        defect: '明暗片'
      })
    ).toThrow(/grade/)
  })

  it('未知占位符报错', () => {
    expect(() => renderTemplate('\\\\host\\share\\{unknown}', {})).toThrow(TemplateError)
  })
})

describe('validatePath', () => {
  it('接受 UNC 与盘符路径', () => {
    expect(() => validatePath('\\\\10.108.9.153\\pl-6b')).not.toThrow()
    expect(() => validatePath('Z:\\DC\\B04-A')).not.toThrow()
  })

  it('拒绝相对路径、重复分隔符与 ..', () => {
    expect(() => validatePath('relative\\path')).toThrow(TemplateError)
    expect(() => validatePath('\\\\host\\\\share')).toThrow(TemplateError)
    expect(() => validatePath('\\\\host\\..\\share')).toThrow(TemplateError)
  })
})
