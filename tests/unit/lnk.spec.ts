import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseLnk } from '@infra/lnk/parseLnk'

const fixtureRoot = join(process.cwd(), 'tests/fixtures/lnk/力禧特')
const expected = JSON.parse(readFileSync(join(fixtureRoot, 'lnk.json'), 'utf8')) as Record<
  string,
  Record<string, string>
>

const PROPERTY_STORE_CONSTANT = '\\\\10.108.229.131'
const ENV_SIGNATURE = Buffer.from([0x01, 0x00, 0x00, 0xa0])

function readSample(region: string, machine: string): Buffer {
  return readFileSync(join(fixtureRoot, region, `${machine}.lnk`))
}

/** EnvVar 块起点 = 签名位置 - 4（BlockSize） */
function envBlockStart(buf: Buffer): number {
  const index = buf.indexOf(ENV_SIGNATURE)
  if (index < 4) throw new Error('样本里找不到 EnvironmentVariableDataBlock')
  return index - 4
}

describe('parseLnk：8 个真实样本', () => {
  for (const [region, machines] of Object.entries(expected)) {
    for (const [machine, target] of Object.entries(machines)) {
      it(`${region} ${machine}`, () => {
        const result = parseLnk(readSample(region, machine))

        expect(result.brokenReason).toBeUndefined()
        expect(result.target).toBe(target)
        expect(result.targetSource).toBe('envVar')
        expect(result.encoding).toBe('utf16')
        expect(result.conflict).toBe(false)
        expect(result.conflictCandidates).toEqual([])

        // 西区 1A 恰好等于残留值，不应报 mismatch
        if (target === PROPERTY_STORE_CONSTANT) {
          expect(result.propertyStoreMismatch).toBeUndefined()
        } else {
          expect(result.propertyStoreMismatch).toBe(PROPERTY_STORE_CONSTANT)
        }
      })
    }
  }
})

describe('parseLnk：来源回退与冲突', () => {
  it('Unicode 为空时回退 ANSI，编码标记为 gbk', () => {
    const buf = readSample('东区', '1A')
    const start = envBlockStart(buf)
    buf.fill(0, start + 268, start + 268 + 520)

    const result = parseLnk(buf)
    expect(result.target).toBe('\\\\10.108.8.232')
    expect(result.targetSource).toBe('envVar')
    expect(result.encoding).toBe('gbk')
  })

  it('EnvVar 两段都为空时兜底 PropertyStore', () => {
    const buf = readSample('东区', '1A')
    const start = envBlockStart(buf)
    buf.fill(0, start + 8, start + 268)
    buf.fill(0, start + 268, start + 268 + 520)

    const result = parseLnk(buf)
    expect(result.target).toBe(PROPERTY_STORE_CONSTANT)
    expect(result.targetSource).toBe('propStore')
    expect(result.propertyStoreMismatch).toBeUndefined()
  })

  it('EnvVar 的 Unicode 与 ANSI 主机不同时标记 conflict', () => {
    const buf = readSample('东区', '1A')
    const start = envBlockStart(buf)
    buf.fill(0, start + 8, start + 268)
    Buffer.from('\\\\10.108.99.9', 'latin1').copy(buf, start + 8)

    const result = parseLnk(buf)
    expect(result.conflict).toBe(true)
    expect(result.conflictCandidates).toContain('\\\\10.108.8.232')
    expect(result.conflictCandidates).toContain('\\\\10.108.99.9')
    expect(result.target).toBe('\\\\10.108.8.232')
  })

  it('头部不合法时返回 broken', () => {
    const result = parseLnk(Buffer.alloc(10))
    expect(result.target).toBeNull()
    expect(result.brokenReason).toContain('76')
  })
})
