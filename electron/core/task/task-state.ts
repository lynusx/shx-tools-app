import type { TaskState } from '@shared/task'

/**
 * 合法迁移表。纯函数、无 IO，越界迁移一律抛错——
 * 「状态只由主进程写」这条原则的落点就在这张表。
 */
const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  created: ['preparing', 'failed', 'canceled'],
  preparing: ['running', 'succeeded', 'paused', 'failed', 'canceled', 'interrupted'],
  running: ['succeeded', 'paused', 'failed', 'canceled', 'interrupted'],
  paused: ['preparing', 'canceled'],
  interrupted: ['preparing', 'canceled'],
  succeeded: [],
  failed: [],
  canceled: []
}

export const TASK_STATES = Object.keys(TRANSITIONS) as TaskState[]

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to)
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw new Error(`非法任务状态迁移：${from} → ${to}`)
  }
}

export function isTerminal(state: TaskState): boolean {
  return TRANSITIONS[state].length === 0
}

export function isResumable(state: TaskState): boolean {
  return state === 'paused' || state === 'interrupted'
}
