/**
 * F1 图片收集 · 扫描执行器。
 *
 * 任务行来自参数展开出的固定列表；执行过程只做三件事：分组扫描、逐条回传、
 * 续传时按 dirs.jsonl 里已出现的 path 跳过（不重扫、不重算）。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DirRecord, DirStatus, ScanContext, ScanResult } from '@shared/tool-contract'
import type { ScanUnit } from './expand'
import { expandScanUnits } from './expand'
import { imageScanParams } from './params'
import { scanUnits, type ScanSummary } from './scanner'
import { PRODUCTS, type ProductType } from './template'

const EMPTY_STATUS: Record<DirStatus, number> = {
  ok: 0,
  empty: 0,
  missing: 0,
  unreachable: 0,
  denied: 0,
  error: 0
}

function emptySummary(): ScanSummary {
  return {
    dirCount: 0,
    fileCount: 0,
    bytes: 0,
    byStatus: { ...EMPTY_STATUS },
    diagnostics: { probeCalls: 0, leafCalls: 0, skippedByPrefix: 0 }
  }
}

export function summarizeRecords(records: readonly DirRecord[]): ScanSummary {
  const summary = emptySummary()
  for (const record of records) {
    summary.dirCount += 1
    summary.byStatus[record.status] += 1
    summary.fileCount += record.fileCount
    summary.bytes += record.bytes
  }
  return summary
}

export function mergeSummaries(base: ScanSummary, run: ScanSummary): ScanSummary {
  const merged = emptySummary()
  merged.dirCount = base.dirCount + run.dirCount
  merged.fileCount = base.fileCount + run.fileCount
  merged.bytes = base.bytes + run.bytes
  for (const status of Object.keys(EMPTY_STATUS) as DirStatus[]) {
    merged.byStatus[status] = base.byStatus[status] + run.byStatus[status]
  }
  merged.diagnostics = {
    probeCalls: base.diagnostics.probeCalls + run.diagnostics.probeCalls,
    leafCalls: base.diagnostics.leafCalls + run.diagnostics.leafCalls,
    skippedByPrefix: base.diagnostics.skippedByPrefix + run.diagnostics.skippedByPrefix
  }
  return merged
}

/** dirs.jsonl 是扫描的进度账本：按 path 求差即可续传（F1 §3.7） */
export async function loadCheckpoint(
  taskDir: string,
  taskId: string
): Promise<Map<string, DirRecord>> {
  const raw = await readFile(join(taskDir, `${taskId}.dirs.jsonl`), 'utf8').catch(() => '')
  const records = new Map<string, DirRecord>()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as DirRecord
      if (typeof record.path === 'string') records.set(record.path, record)
    } catch {
      // 坏行（半截写入）跳过，最多重扫该目录
    }
  }
  return records
}

function resolveHours(productType: ProductType, shift: string, hourSlots: string[]): string[] {
  if (hourSlots.length > 0) return hourSlots
  return [...(PRODUCTS[productType].shifts[shift] ?? [])]
}

export async function scanImageCollector(raw: unknown, ctx: ScanContext): Promise<ScanResult> {
  const params = imageScanParams.parse(raw)
  const hours = resolveHours(params.productType, params.shift, params.hourSlots)
  if (hours.length === 0) {
    throw new Error(`班次「${params.shift}」没有可用时段`)
  }

  const units: ScanUnit[] = expandScanUnits({
    productType: params.productType,
    machines: params.machines,
    date: params.date,
    shift: params.shift,
    hourSlots: hours,
    defects: params.defects,
    subDir: params.subDir
  })

  const checkpoint =
    ctx.resumeFrom && ctx.resumeFrom > 0
      ? await loadCheckpoint(ctx.tempDir, ctx.taskId)
      : new Map<string, DirRecord>()

  const pending = units.filter((unit) => !checkpoint.has(unit.path))
  const total = units.length
  const base = summarizeRecords([...checkpoint.values()])
  let done = total - pending.length
  let filesSoFar = base.fileCount
  let bytesSoFar = base.bytes

  const { summary: runSummary } = await scanUnits(pending, {
    productType: params.productType,
    extensions: params.extensions,
    dedupe: params.dedupe,
    signal: ctx.signal,
    concurrency: 4,
    onDir: (scan) => {
      for (const file of scan.files) ctx.appendFile(file)
      ctx.appendDir(scan.record)
      done += 1
      filesSoFar += scan.record.fileCount
      bytesSoFar += scan.record.bytes
      ctx.report({
        done,
        total,
        phase: 'scanning',
        current: scan.record.path,
        metrics: {
          dirCountDone: done,
          dirCountTotal: total,
          fileCount: filesSoFar,
          bytes: bytesSoFar
        }
      })
    }
  })

  const summary = mergeSummaries(base, runSummary)
  summary.dirCount = total

  return { summary }
}
