import { describe, expect, it } from 'vitest'
import {
  ExpandError,
  MAX_SCAN_UNITS,
  countScanUnits,
  expandScanUnits,
  type ExpandParams,
  type MachineTarget
} from '@tools/image-collector/expand'
import { PRODUCTS } from '@tools/image-collector/template'

const lipoMachines: MachineTarget[] = [
  { code: '6B', root: '\\\\10.108.9.153' },
  { code: '7A', root: '\\\\10.108.9.154' },
  { code: '8B', root: '\\\\10.108.9.155' }
]

const lipoParams: ExpandParams = {
  productType: 'lipo',
  machines: lipoMachines,
  date: '2026-10-23',
  shift: '白班',
  hourSlots: PRODUCTS.lipo.shifts['白班']?.slice(0, 10) ?? [],
  defects: ['明暗片', 'NG_连续性断栅_A-']
}

const lixiteParams: ExpandParams = {
  productType: 'lixite',
  machines: [
    { code: '1A', root: '\\\\10.108.8.232' },
    { code: '1B', root: '\\\\10.108.229.132' }
  ],
  date: '2026-10-23',
  shift: '白班',
  hourSlots: ['8', '9'],
  defects: ['NG_连续性断栅_A-', 'NG_脏污_B'],
  subDir: 'SaveImages'
}

const elParams: ExpandParams = {
  productType: 'el',
  machines: [
    { code: 'B04-A', root: '\\\\10.108.164.2\\qj-dc-el\\DC\\B04-A' },
    { code: 'A05-A', root: '\\\\10.108.164.2\\qj-dc-el\\DC\\A05-A' }
  ],
  date: '2026-10-23',
  shift: '白班',
  hourSlots: ['8', '18'],
  defects: ['NG_脏污_B']
}

describe('expandScanUnits：规模与顺序', () => {
  it('利珀组合数含等级：3 机台 × 10 时段 × 2 缺陷 × 3 等级 = 180', () => {
    expect(countScanUnits(lipoParams)).toBe(180)
    expect(expandScanUnits(lipoParams)).toHaveLength(180)
  })

  it('同一机台的目录连续，避免在 UNC 主机间来回切换', () => {
    const units = expandScanUnits(lipoParams)
    const firstMachine = units.slice(0, 60)
    expect(firstMachine.every((unit) => unit.combo['machine'] === '6B')).toBe(true)
    expect(units[60]?.combo['machine']).toBe('7A')
  })

  it('首条路径与分页字段符合模板', () => {
    const [first] = expandScanUnits(lipoParams)
    expect(first?.path).toBe(
      '\\\\10.108.9.153\\pl-6b\\Matting\\2026.10.23\\6B\\白班\\08\\Fail\\A\\明暗片'
    )
    expect(first?.probePath).toBe('\\\\10.108.9.153\\pl-6b\\Matting\\2026.10.23\\6B\\白班')
    expect(first?.combo).toMatchObject({
      machine: '6B',
      date: '2026.10.23',
      shift: '白班',
      hour: '08',
      defect: '明暗片',
      grade: 'A'
    })
  })

  it('等级在最内层：同一时段/缺陷下按 A→B→C 排列', () => {
    const units = expandScanUnits(lipoParams)
    expect(units.slice(0, 3).map((unit) => unit.combo['grade'])).toEqual(['A', 'B', 'C'])
  })
})

describe('expandScanUnits：产品差异', () => {
  it('力禧特代入入口扫描确定的 subDir，路径无等级段', () => {
    const units = expandScanUnits(lixiteParams)
    expect(units).toHaveLength(8)
    expect(units[0]?.path).toBe(
      '\\\\10.108.8.232\\SaveImages\\A-01-B\\20261023\\白班\\8\\NG_连续性断栅_A-'
    )
    expect(units[0]?.probePath).toBe('\\\\10.108.8.232\\SaveImages\\A-01-B\\20261023\\白班')
    expect(units[0]?.combo['subDir']).toBe('SaveImages')
  })

  it('力禧特缺 subDir 时拒绝展开', () => {
    const withoutSubDir: ExpandParams = { ...lixiteParams, subDir: undefined }
    expect(() => expandScanUnits(withoutSubDir)).toThrow(ExpandError)
  })

  it('EL 机台名在根路径末尾，模板再拼 EL 段', () => {
    const units = expandScanUnits(elParams)
    expect(units).toHaveLength(4)
    expect(units[0]?.path).toBe(
      '\\\\10.108.164.2\\qj-dc-el\\DC\\B04-A\\EL\\20261023\\白班\\8\\NG_脏污_B'
    )
  })
})

describe('expandScanUnits：参数与上限', () => {
  it('时段不属于所选班次时报错', () => {
    expect(() => expandScanUnits({ ...lipoParams, hourSlots: ['07'] })).toThrow(ExpandError)
  })

  it('未知班次报错', () => {
    expect(() => expandScanUnits({ ...lipoParams, shift: '中班' })).toThrow(ExpandError)
  })

  it('超过 20000 时拒绝执行', () => {
    const machines = Array.from({ length: 120 }, (_, index) => ({
      code: `${index}B`,
      root: `\\\\10.108.9.${index + 1}`
    }))
    const params: ExpandParams = {
      ...lipoParams,
      machines,
      hourSlots: [...(PRODUCTS.lipo.shifts['白班'] ?? [])],
      defects: ['明暗片', 'NG_1', 'NG_2', 'NG_3', 'NG_4']
    }

    expect(countScanUnits(params)).toBeGreaterThan(MAX_SCAN_UNITS)
    expect(() => expandScanUnits(params)).toThrow(ExpandError)
  })
})
