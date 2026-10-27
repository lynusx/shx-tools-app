/**
 * 目录扫描：六态归类 + 前缀预检。
 *
 * 任务行来自预先展开的固定列表，扫描只负责给每行判状态；前缀预检只省 I/O，
 * 不删行、不改变顺序、不改分母（见 F1 §3.1 / §3.5）。
 */

import { createHash } from 'node:crypto'
import { opendir, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DirRecord, DirStatus, FileRecord } from '@shared/tool-contract'
import type { ScanUnit } from './expand'
import { matchesExtension } from './filter'
import { LayoutError, buildDest } from './layout'
import type { ProductType } from './template'

const STATUS_BY_CODE: Readonly<Record<string, DirStatus>> = {
  ENOENT: 'missing',
  ENOTDIR: 'missing',
  ETIMEDOUT: 'unreachable',
  EHOSTUNREACH: 'unreachable',
  ENETUNREACH: 'unreachable',
  ECONNREFUSED: 'unreachable',
  ECONNRESET: 'unreachable',
  EPIPE: 'unreachable',
  EAI_AGAIN: 'unreachable',
  EACCES: 'denied',
  EPERM: 'denied'
}

export function statusForCode(code: string | undefined): DirStatus {
  if (!code) return 'error'
  return STATUS_BY_CODE[code] ?? 'error'
}

export function errorCodeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

export interface ScanOneOptions {
  productType: ProductType
  extensions: readonly string[]
  dedupe?: boolean
  signal?: AbortSignal
}

export interface DirScan {
  record: DirRecord
  files: FileRecord[]
}

function elapsedSince(startedAt: number): number {
  return Math.round(performance.now() - startedAt)
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return `sha256:${hash.digest('hex')}`
}

/** 单个目录：列目录 → 过滤扩展名 → 算 dest →（可选）算 hash → 归类 */
export async function scanOne(unit: ScanUnit, options: ScanOneOptions): Promise<DirScan> {
  const startedAt = performance.now()
  options.signal?.throwIfAborted()

  try {
    const entries = await readdir(unit.path, { withFileTypes: true })
    const files: FileRecord[] = []

    for (const entry of entries) {
      options.signal?.throwIfAborted()
      if (!entry.isFile()) continue
      if (!matchesExtension(entry.name, options.extensions)) continue

      const src = join(unit.path, entry.name)
      let bytes: number
      try {
        bytes = (await stat(src)).size
      } catch (error) {
        // 列目录与 stat 之间文件被删：跳过即可，不把整个目录判失败
        if (errorCodeOf(error) === 'ENOENT') continue
        throw error
      }

      const file: FileRecord = {
        src,
        dest: buildDest(options.productType, unit.combo, entry.name),
        bytes
      }
      if (options.dedupe) file.hash = await sha256(src)
      files.push(file)
    }

    const bytes = files.reduce((sum, file) => sum + file.bytes, 0)
    return {
      record: {
        path: unit.path,
        combo: unit.combo,
        status: files.length > 0 ? 'ok' : 'empty',
        fileCount: files.length,
        bytes,
        elapsedMs: elapsedSince(startedAt)
      },
      files
    }
  } catch (error) {
    if (error instanceof LayoutError || options.signal?.aborted) throw error
    const code = errorCodeOf(error)
    return {
      record: {
        path: unit.path,
        combo: unit.combo,
        status: statusForCode(code),
        fileCount: 0,
        bytes: 0,
        elapsedMs: elapsedSince(startedAt),
        code
      },
      files: []
    }
  }
}

export type PrefixProbeKind = 'ok' | 'empty' | 'missing' | 'unreachable' | 'denied' | 'error'

export interface PrefixProbe {
  kind: PrefixProbeKind
  code?: string
}

/**
 * 前缀探测：到班次一级。只读 1 条 entry 判空——`stat` 判不出空目录。
 */
export async function probePrefix(path: string, signal?: AbortSignal): Promise<PrefixProbe> {
  signal?.throwIfAborted()
  try {
    const dir = await opendir(path)
    try {
      const first = await dir.read()
      return first ? { kind: 'ok' } : { kind: 'empty' }
    } finally {
      await dir.close()
    }
  } catch (error) {
    const code = errorCodeOf(error)
    return { kind: statusForCode(code), code }
  }
}

export interface ScanSummary {
  dirCount: number
  fileCount: number
  bytes: number
  byStatus: Record<DirStatus, number>
  diagnostics: {
    probeCalls: number
    leafCalls: number
    skippedByPrefix: number
  }
}

export interface ScanUnitsOptions extends ScanOneOptions {
  concurrency?: number
  onDir?: (scan: DirScan) => void
}

export interface ScanUnitsResult {
  summary: ScanSummary
  results: DirScan[]
}

function emptyRecord(unit: ScanUnit, status: DirStatus): DirRecord {
  return {
    path: unit.path,
    combo: unit.combo,
    status,
    fileCount: 0,
    bytes: 0,
    elapsedMs: 0
  }
}

async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next
      next += 1
      const item = items[index] as T
      results[index] = await fn(item)
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

/**
 * 按展开顺序扫描：同 probePath 天然连续，每组探测一次。
 * missing / empty → 整组标 missing；unreachable → 整组标 unreachable；
 * denied / error → 不传播，照常逐叶（Windows ACL 可能父目录拒绝、子目录单独授权）。
 */
export async function scanUnits(
  units: readonly ScanUnit[],
  options: ScanUnitsOptions
): Promise<ScanUnitsResult> {
  const summary: ScanSummary = {
    dirCount: 0,
    fileCount: 0,
    bytes: 0,
    byStatus: { ok: 0, empty: 0, missing: 0, unreachable: 0, denied: 0, error: 0 },
    diagnostics: { probeCalls: 0, leafCalls: 0, skippedByPrefix: 0 }
  }
  const results: DirScan[] = []
  const concurrency = Math.max(1, options.concurrency ?? 4)

  const push = (scan: DirScan): void => {
    results.push(scan)
    summary.dirCount += 1
    summary.byStatus[scan.record.status] += 1
    summary.fileCount += scan.record.fileCount
    summary.bytes += scan.record.bytes
    options.onDir?.(scan)
  }

  let index = 0
  while (index < units.length) {
    options.signal?.throwIfAborted()

    const current = units[index]
    if (!current) break
    const prefix = current.probePath

    let end = index
    while (end < units.length && units[end]?.probePath === prefix) end += 1

    summary.diagnostics.probeCalls += 1
    const probe = await probePrefix(prefix, options.signal)
    const group = units.slice(index, end)

    if (probe.kind === 'missing' || probe.kind === 'empty' || probe.kind === 'unreachable') {
      const status: DirStatus = probe.kind === 'unreachable' ? 'unreachable' : 'missing'
      for (const unit of group) push({ record: emptyRecord(unit, status), files: [] })
      summary.diagnostics.skippedByPrefix += group.length
    } else {
      const scans = await mapPool(group, concurrency, async (unit) => {
        summary.diagnostics.leafCalls += 1
        return scanOne(unit, options)
      })
      for (const scan of scans) push(scan)
    }

    index = end
  }

  return { summary, results }
}
