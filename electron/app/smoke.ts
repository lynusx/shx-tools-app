import type { ScanSummary } from '@shared/tool-contract'
import type { TaskRecord } from '@shared/task'
import { isTerminal } from '../core/task/task-state'
import type { TaskManager } from '../core/task/task-manager'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitTerminal(
  manager: TaskManager,
  id: string,
  timeoutMs = 60_000
): Promise<TaskRecord> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const record = manager.get(id)
    if (isTerminal(record.state)) return record
    await sleep(50)
  }
  throw new Error(`smoke 超时：任务 ${id} 未在 ${timeoutMs}ms 内结束`)
}

/**
 * M0 冒烟：不需要窗口，直接驱动 TaskManager 跑通
 * scan → 明细落盘 → 暂停 → 继续 → copy → 报告，然后退出。
 */
export async function runSmoke(tasks: TaskManager): Promise<number> {
  console.log('[smoke] 创建扫描任务（30 个目录，每目录 1 个文件）')
  const scan = await tasks.create({
    toolId: 'fake',
    kind: 'scan',
    params: { dirs: 30, filesPerDir: 1, delayMs: 40 }
  })

  await sleep(900)
  console.log('[smoke] 暂停扫描')
  await tasks.pause(scan.id)
  console.log(`[smoke] 暂停后状态：${tasks.get(scan.id).state}`)

  const dirsBeforeResume = await tasks.dirs(scan.id, 0, 1000)
  console.log(`[smoke] 暂停时已落盘目录：${dirsBeforeResume.total}`)
  if (dirsBeforeResume.total === 0) {
    console.error('[smoke] 暂停时没有任何明细落盘，续传等于重跑')
    return 2
  }

  await sleep(200)
  console.log('[smoke] 继续扫描')
  await tasks.resume(scan.id)
  const scanDone = await waitTerminal(tasks, scan.id)
  console.log(`[smoke] 扫描结束：${scanDone.state}`)
  if (scanDone.state !== 'succeeded') {
    console.error('[smoke] 扫描失败', scanDone.error)
    return 1
  }

  const summary = scanDone.summary as ScanSummary
  const dirRows = await tasks.dirs(scan.id, 0, 10_000)
  const fileRows = await tasks.files(scan.id, 0, 10_000)
  console.log(
    `[smoke] 汇总 ${summary.dirCount} 目录 / ${summary.fileCount} 文件；落盘 ${dirRows.total} 目录 / ${fileRows.total} 文件`
  )
  if (dirRows.total !== summary.dirCount || fileRows.total !== summary.fileCount) {
    console.error('[smoke] 明细行数与汇总不一致')
    return 1
  }

  console.log('[smoke] 创建复制任务')
  const copy = await tasks.create({
    toolId: 'fake',
    kind: 'copy',
    params: { sourceScanId: scan.id, delayMs: 5 }
  })
  const copyDone = await waitTerminal(tasks, copy.id)
  console.log(`[smoke] 复制结束：${copyDone.state}，报告：${copyDone.artifacts?.[0]?.path ?? '无'}`)
  if (copyDone.state !== 'succeeded') {
    console.error('[smoke] 复制失败', copyDone.error)
    return 1
  }

  console.log('[smoke] 通过')
  return 0
}
