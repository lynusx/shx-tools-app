import { open, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * 原子写：临时文件 → fsync → rename。
 * 断电时要么是旧文件，要么是新文件，不会出现半截 JSON。
 */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, file)
}

/** 追加 JSONL 并 fsync：明细必须先于汇总落盘 */
export async function appendJsonl(file: string, rows: readonly unknown[]): Promise<void> {
  if (rows.length === 0) return
  await mkdir(dirname(file), { recursive: true })
  const handle = await open(file, 'a')
  try {
    await handle.writeFile(rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}
