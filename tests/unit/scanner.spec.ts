import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ScanUnit } from '@tools/image-collector/expand'
import { matchesExtension, normalizeExtensions } from '@tools/image-collector/filter'
import { LayoutError, buildDest } from '@tools/image-collector/layout'
import { probePrefix, scanOne, scanUnits, statusForCode } from '@tools/image-collector/scanner'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'shx-scan-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const combo = {
  date: '2026.10.23',
  region: '东区',
  machine: '6B',
  defect: '明暗片',
  hour: '08',
  grade: 'A'
}

function unit(path: string, probePath: string): ScanUnit {
  return { path, probePath, combo }
}

const options = { productType: 'lipo' as const, extensions: ['jpg', 'png'] }

describe('buildDest', () => {
  it('利珀输出日期转为中划线，含等级层', () => {
    expect(buildDest('lipo', combo, 'a.jpg')).toBe('2026-10-23\\东区\\6B\\明暗片\\08\\A\\a.jpg')
  })

  it('EL 无等级层，日期保持 YYYYMMDD', () => {
    const dest = buildDest(
      'el',
      { date: '20261023', region: '西区', machine: 'B04-A', defect: 'NG_脏污_B', hour: '18' },
      'b.jpg'
    )
    expect(dest).toBe('20261023\\西区\\B04-A\\NG_脏污_B\\18\\b.jpg')
  })

  it('利珀缺等级时报错', () => {
    expect(() => buildDest('lipo', { ...combo, grade: undefined }, 'a.jpg')).toThrow(LayoutError)
  })
})

describe('扩展名过滤', () => {
  it('归一化去重、去点、转小写', () => {
    expect(normalizeExtensions(['JPG', '.png', 'jpg', ''])).toEqual(['jpg', 'png'])
  })

  it('大小写不敏感，忽略无扩展名与点开头文件', () => {
    expect(matchesExtension('A.JPG', ['jpg'])).toBe(true)
    expect(matchesExtension('a.txt', ['jpg'])).toBe(false)
    expect(matchesExtension('noext', ['jpg'])).toBe(false)
    expect(matchesExtension('.hidden', ['hidden'])).toBe(false)
  })
})

describe('scanOne：六态', () => {
  it('有图片 → ok，按扩展名过滤并生成相对 dest', async () => {
    const dir = join(root, 'leaf')
    await mkdir(join(dir, 'sub'), { recursive: true })
    await writeFile(join(dir, 'a.JPG'), 'abc')
    await writeFile(join(dir, 'b.png'), 'de')
    await writeFile(join(dir, 'note.txt'), 'ignored')
    await writeFile(join(dir, 'sub', 'c.jpg'), 'ignored')

    const scan = await scanOne(unit(dir, join(root, 'probe')), options)

    expect(scan.record.status).toBe('ok')
    expect(scan.record.fileCount).toBe(2)
    expect(scan.record.bytes).toBe(5)
    expect(scan.files.map((file) => file.dest).sort()).toEqual([
      '2026-10-23\\东区\\6B\\明暗片\\08\\A\\a.JPG',
      '2026-10-23\\东区\\6B\\明暗片\\08\\A\\b.png'
    ])
  })

  it('目录可读但无图片 → empty', async () => {
    const dir = join(root, 'empty')
    await mkdir(dir)
    await writeFile(join(dir, 'readme.txt'), 'x')

    const scan = await scanOne(unit(dir, join(root, 'probe')), options)
    expect(scan.record.status).toBe('empty')
    expect(scan.record.fileCount).toBe(0)
  })

  it('目录不存在 → missing 并带错误码', async () => {
    const scan = await scanOne(unit(join(root, 'nope'), join(root, 'probe')), options)
    expect(scan.record.status).toBe('missing')
    expect(scan.record.code).toBe('ENOENT')
  })

  it('dedupe 开启时为文件写 sha256', async () => {
    const dir = join(root, 'dup')
    await mkdir(dir)
    await writeFile(join(dir, 'a.jpg'), 'same')
    await writeFile(join(dir, 'b.jpg'), 'same')

    const scan = await scanOne(unit(dir, join(root, 'probe')), { ...options, dedupe: true })
    const hashes = scan.files.map((file) => file.hash)
    expect(hashes[0]).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(hashes[0]).toBe(hashes[1])
  })
})

describe('状态映射', () => {
  it('错误码按六态归类', () => {
    expect(statusForCode('ENOENT')).toBe('missing')
    expect(statusForCode('ETIMEDOUT')).toBe('unreachable')
    expect(statusForCode('EACCES')).toBe('denied')
    expect(statusForCode('EUNKNOWN')).toBe('error')
    expect(statusForCode(undefined)).toBe('error')
  })
})

describe('前缀预检', () => {
  it('前缀缺失时整组标 missing，不发起叶子 I/O', async () => {
    const prefix = join(root, 'missing-prefix')
    const units = [unit(join(prefix, '08', 'A'), prefix), unit(join(prefix, '09', 'A'), prefix)]

    const { summary, results } = await scanUnits(units, { ...options, concurrency: 1 })

    expect(results.map((scan) => scan.record.status)).toEqual(['missing', 'missing'])
    expect(summary.byStatus.missing).toBe(2)
    expect(summary.diagnostics.skippedByPrefix).toBe(2)
    expect(summary.diagnostics.leafCalls).toBe(0)
    expect(summary.diagnostics.probeCalls).toBe(1)
  })

  it('前缀存在但为空 → 整组按 missing 传播', async () => {
    const prefix = join(root, 'empty-prefix')
    await mkdir(prefix)
    const units = [unit(join(prefix, '08', 'A'), prefix)]

    const { summary, results } = await scanUnits(units, { ...options, concurrency: 1 })

    expect(results[0]?.record.status).toBe('missing')
    expect(summary.diagnostics.skippedByPrefix).toBe(1)
  })

  it('前缀可读时逐叶扫描，空/缺失各自归类', async () => {
    const prefix = join(root, 'probe-ok')
    const okLeaf = join(prefix, '08', 'A')
    const missingLeaf = join(prefix, '09', 'A')
    await mkdir(okLeaf, { recursive: true })
    await writeFile(join(okLeaf, 'a.jpg'), 'abc')

    const units = [unit(okLeaf, prefix), unit(missingLeaf, prefix)]
    const { summary, results } = await scanUnits(units, { ...options, concurrency: 2 })

    expect(results.map((scan) => scan.record.status).sort()).toEqual(['missing', 'ok'])
    expect(summary.fileCount).toBe(1)
    expect(summary.diagnostics.leafCalls).toBe(2)
    expect(summary.diagnostics.skippedByPrefix).toBe(0)
  })

  it('探测到文件路径按 missing 处理（ENOTDIR）', async () => {
    const file = join(root, 'a-file')
    await writeFile(file, 'x')
    const probe = await probePrefix(file)
    expect(probe.kind).toBe('missing')
  })
})
