import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirRecord, ScanContext } from '@shared/tool-contract'
import { expandScanUnits } from '@tools/image-collector/expand'
import {
  loadCheckpoint,
  mergeSummaries,
  scanImageCollector,
  summarizeRecords
} from '@tools/image-collector/scan'

let taskDir: string

beforeEach(async () => {
  taskDir = await mkdtemp(join(tmpdir(), 'shx-scan-exec-'))
})

afterEach(async () => {
  await rm(taskDir, { recursive: true, force: true })
})

const params = {
  entryPath: '\\\\10.108.164.2\\qj-dc-el\\DC',
  entryForm: 'shortcut',
  productType: 'lipo',
  machines: [{ code: '6B', region: '东区', root: '\\\\10.108.9.153' }],
  date: '2026-10-23',
  shift: '白班',
  hourSlots: [],
  defects: ['明暗片'],
  extensions: ['jpg'],
  dedupe: false
}

function makeContext(overrides: Partial<ScanContext> = {}): ScanContext {
  const controller = new AbortController()
  return {
    taskId: 'task-1',
    tempDir: taskDir,
    signal: controller.signal,
    report: vi.fn(),
    log: vi.fn(),
    appendDir: vi.fn(),
    appendFile: vi.fn(),
    ...overrides
  }
}

const record: DirRecord = {
  path: '\\\\10.108.9.153\\pl-6b\\Matting\\2026.10.23\\6B\\白班\\08\\Fail\\A\\明暗片',
  combo: { machine: '6B' },
  status: 'ok',
  fileCount: 2,
  bytes: 100,
  elapsedMs: 1
}

describe('汇总与检查点', () => {
  it('按状态聚合目录、文件与字节', () => {
    const summary = summarizeRecords([
      record,
      { ...record, path: 'x', status: 'missing', fileCount: 0, bytes: 0 }
    ])
    expect(summary.dirCount).toBe(2)
    expect(summary.fileCount).toBe(2)
    expect(summary.bytes).toBe(100)
    expect(summary.byStatus.ok).toBe(1)
    expect(summary.byStatus.missing).toBe(1)
  })

  it('合并两段汇总', () => {
    const left = summarizeRecords([record])
    const right = summarizeRecords([{ ...record, path: 'y', fileCount: 1, bytes: 10 }])
    const merged = mergeSummaries(left, right)
    expect(merged.dirCount).toBe(2)
    expect(merged.fileCount).toBe(3)
    expect(merged.bytes).toBe(110)
  })

  it('读取 dirs.jsonl 作为续传检查点，坏行跳过', async () => {
    await writeFile(
      join(taskDir, 'task-1.dirs.jsonl'),
      `${JSON.stringify(record)}\n{broken\n${JSON.stringify({ ...record, path: 'b' })}\n`,
      'utf8'
    )

    const checkpoint = await loadCheckpoint(taskDir, 'task-1')
    expect(checkpoint.size).toBe(2)
    expect(checkpoint.get(record.path)?.fileCount).toBe(2)
  })
})

describe('scanImageCollector', () => {
  it('时段留空时展开该班次全部 12 小时', async () => {
    const ctx = makeContext()
    const result = await scanImageCollector(params, ctx)

    expect(result.summary.dirCount).toBe(36)
    expect(result.summary.byStatus.missing).toBe(36)
    expect(ctx.report).toHaveBeenCalled()
  })

  it('续传时跳过检查点里的路径，并从已有进度继续报数', async () => {
    const [firstUnit] = expandScanUnits({
      productType: 'lipo',
      machines: params.machines,
      date: params.date,
      shift: params.shift,
      hourSlots: ['08', '09'],
      defects: ['明暗片']
    })

    await writeFile(
      join(taskDir, 'task-1.dirs.jsonl'),
      `${JSON.stringify({ ...record, path: firstUnit?.path ?? '' })}\n`,
      'utf8'
    )

    const report = vi.fn()
    const ctx = makeContext({ resumeFrom: 1, report })
    const result = await scanImageCollector({ ...params, hourSlots: ['08', '09'] }, ctx)

    expect(result.summary.dirCount).toBe(6)
    // 检查点里的目录算 1 个，剩下的 5 个由本次扫描补齐
    expect(ctx.appendDir).toHaveBeenCalledTimes(5)
    const lastReport = report.mock.calls.at(-1)?.[0] as { done: number; total: number } | undefined
    expect(lastReport?.done).toBe(6)
    expect(lastReport?.total).toBe(6)
  })

  it('班次没有可用时段时报错', async () => {
    await expect(scanImageCollector({ ...params, shift: '中班' }, makeContext())).rejects.toThrow(
      /可用时段/
    )
  })
})
