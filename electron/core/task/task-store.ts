import { mkdir, readdir, readFile, rename, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { DirRecord, FileRecord, TaskKind } from '@shared/tool-contract'
import type { Page, TaskRecord } from '@shared/task'
import { appendJsonl, writeJsonAtomic } from '../storage/atomic-write'

export class TaskStore {
  constructor(readonly root: string) {}

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true })
  }

  recordPath(id: string): string {
    return join(this.root, `${id}.json`)
  }

  dirsPath(id: string): string {
    return join(this.root, `${id}.dirs.jsonl`)
  }

  filesPath(id: string): string {
    return join(this.root, `${id}.files.jsonl`)
  }

  async save(record: TaskRecord): Promise<void> {
    await writeJsonAtomic(this.recordPath(record.id), record)
  }

  async read(id: string): Promise<TaskRecord | null> {
    const file = this.recordPath(id)
    try {
      const raw = await readFile(file, 'utf8')
      return JSON.parse(raw) as TaskRecord
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      // 解析失败：坏文件改名，UI 显示「记录损坏」而不是白屏
      await rename(file, `${file}.corrupt`).catch(() => undefined)
      return null
    }
  }

  async list(): Promise<TaskRecord[]> {
    const names = await readdir(this.root).catch(() => [] as string[])
    const records: TaskRecord[] = []
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.tmp') || name.endsWith('.corrupt')) continue
      const record = await this.read(name.slice(0, -'.json'.length))
      if (record) records.push(record)
    }
    return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  async appendDirs(id: string, rows: readonly DirRecord[]): Promise<void> {
    await appendJsonl(this.dirsPath(id), rows)
  }

  async appendFiles(id: string, rows: readonly FileRecord[]): Promise<void> {
    await appendJsonl(this.filesPath(id), rows)
  }

  async readDirs(id: string, offset = 0, limit = 200): Promise<Page<DirRecord>> {
    return this.page<DirRecord>(this.dirsPath(id), offset, limit)
  }

  async readFiles(id: string, offset = 0, limit = 200): Promise<Page<FileRecord>> {
    return this.page<FileRecord>(this.filesPath(id), offset, limit)
  }

  async countDirs(id: string): Promise<number> {
    return this.count(this.dirsPath(id))
  }

  async countFiles(id: string): Promise<number> {
    return this.count(this.filesPath(id))
  }

  async remove(id: string): Promise<void> {
    await unlink(this.recordPath(id)).catch(() => undefined)
    await rm(this.dirsPath(id), { force: true }).catch(() => undefined)
    await rm(this.filesPath(id), { force: true }).catch(() => undefined)
    await rm(join(this.root, `${id}.copy.jsonl`), { force: true }).catch(() => undefined)
  }

  /** 按 kind 各保留 200 条；paused / interrupted 永不淘汰 */
  async cleanup(kind: TaskKind, keep = 200): Promise<void> {
    const records = (await this.list()).filter((record) => record.kind === kind)
    const removable = records.filter(
      (record) =>
        !record.resumable &&
        (record.state === 'succeeded' || record.state === 'failed' || record.state === 'canceled')
    )
    for (const record of removable.slice(keep)) {
      await this.remove(record.id)
    }
  }

  private async page<T>(file: string, offset: number, limit: number): Promise<Page<T>> {
    const rows = await this.readJsonl<T>(file)
    const total = rows.length
    const start = Math.max(0, offset)
    return {
      rows: rows.slice(start, start + limit),
      total,
      truncated: start + limit < total
    }
  }

  private async count(file: string): Promise<number> {
    return (await this.readJsonl<unknown>(file)).length
  }

  private async readJsonl<T>(file: string): Promise<T[]> {
    const raw = await readFile(file, 'utf8').catch(() => '')
    const rows: T[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line) as T)
      } catch {
        // 单行损坏不拖垮整份清单
      }
    }
    return rows
  }
}
