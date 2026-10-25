import type { TaskState } from '@shared/task'

const LABELS: Record<TaskState, string> = {
  created: '已创建',
  preparing: '准备中',
  running: '运行中',
  paused: '已暂停',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
  interrupted: '已中断'
}

const COLORS: Record<TaskState, string> = {
  created: 'default',
  preparing: 'processing',
  running: 'processing',
  paused: 'warning',
  succeeded: 'success',
  failed: 'error',
  canceled: 'default',
  interrupted: 'gold'
}

export function stateLabel(state: TaskState): string {
  return LABELS[state]
}

export function stateColor(state: TaskState): string {
  return COLORS[state]
}

export function isTerminalState(state: TaskState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'canceled'
}
