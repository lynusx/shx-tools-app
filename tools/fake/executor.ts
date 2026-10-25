import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileRecord, ScanContext, ToolContext, ToolExecutor } from '@shared/tool-contract'
import { fakeCopyParams, fakeScanParams } from './params'

const FILE_BYTES = 4096

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function abortError(): Error {
  return new Error('任务已取消')
}

async function readJsonl<T>(file: string): Promise<T[]> {
  const raw = await readFile(file, 'utf8').catch(() => '')
  const rows: T[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line) as T)
    } catch {
      // 坏行跳过
    }
  }
  return rows
}

/**
 * 假工具：确定性地产出目录/文件记录，并模拟复制。
 * 存在的意义是让 M0 的「scan → 明细落盘 → copy → 报告」在没有任何真实业务代码时就能跑通。
 */
export const fakeExecutor: ToolExecutor = {
  async scan(raw, ctx: ScanContext) {
    const params = fakeScanParams.parse(raw)
    const start = Math.max(0, Math.min(ctx.resumeFrom ?? 0, params.dirs))
    const fileCount = params.dirs * params.filesPerDir
    const bytes = fileCount * FILE_BYTES

    for (let index = start; index < params.dirs; index += 1) {
      if (ctx.signal.aborted) throw abortError()
      await sleep(params.delayMs)

      const dir = `/fake/dir-${String(index).padStart(4, '0')}`
      for (let file = 0; file < params.filesPerDir; file += 1) {
        ctx.appendFile({
          src: `${dir}/img-${String(file).padStart(3, '0')}.jpg`,
          dest: `dir-${String(index).padStart(4, '0')}/img-${String(file).padStart(3, '0')}.jpg`,
          bytes: FILE_BYTES
        })
      }
      ctx.appendDir({
        path: dir,
        combo: { machine: `M${index % 3}`, hour: String(index % 8) },
        status: 'ok',
        fileCount: params.filesPerDir,
        bytes: params.filesPerDir * FILE_BYTES,
        elapsedMs: params.delayMs
      })
      ctx.report({
        done: index + 1,
        total: params.dirs,
        phase: 'scanning',
        current: dir,
        metrics: { files: (index + 1) * params.filesPerDir }
      })
    }

    return {
      summary: {
        dirCount: params.dirs,
        fileCount,
        bytes,
        byStatus: { ok: params.dirs, empty: 0, missing: 0, unreachable: 0, denied: 0, error: 0 }
      }
    }
  },

  async copy(raw, ctx: ToolContext) {
    const params = fakeCopyParams.parse(raw)
    const sourceRoot = ctx.sourceTaskDir ?? ctx.tempDir
    const files = await readJsonl<FileRecord>(
      join(sourceRoot, `${params.sourceScanId}.files.jsonl`)
    )
    const total = files.length
    const start = Math.max(0, Math.min(ctx.resumeFrom ?? 0, total))
    const bytes = total * FILE_BYTES

    for (let index = start; index < total; index += 1) {
      if (ctx.signal.aborted) throw abortError()
      await sleep(params.delayMs)
      const current = files[index]
      ctx.report({
        done: index + 1,
        total,
        phase: 'copying',
        current: current?.dest,
        metrics: { copied: index + 1 }
      })
    }

    const summary = {
      planned: { fileCount: total, bytes },
      copied: { fileCount: total, bytes },
      conflict: { renamed: 0, overwritten: 0, skippedExisting: 0 },
      skippedDuplicate: 0,
      adopted: start,
      failed: { fileCount: 0 }
    }

    const reportPath = join(tmpdir(), `shx-m0-report-${ctx.taskId}.json`)
    await writeFile(
      reportPath,
      `${JSON.stringify({ taskId: ctx.taskId, summary }, null, 2)}\n`,
      'utf8'
    )

    return {
      summary,
      artifacts: [{ label: '任务报告', path: reportPath }]
    }
  }
}
