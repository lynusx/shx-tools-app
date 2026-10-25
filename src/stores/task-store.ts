import { create } from 'zustand'
import type { TaskProgressEvent, TaskRecord, TaskStateEvent } from '@shared/task'

interface TaskStoreState {
  tasks: TaskRecord[]
  progress: Record<string, TaskProgressEvent>
  loaded: boolean
  load(): Promise<void>
  upsert(task: TaskRecord): void
  applyState(event: TaskStateEvent): Promise<void>
  applyProgress(event: TaskProgressEvent): void
}

export const useTaskStore = create<TaskStoreState>((set, get) => ({
  tasks: [],
  progress: {},
  loaded: false,

  async load() {
    const tasks = await window.shx.task.list({ limit: 200 })
    set({ tasks, loaded: true })
  },

  upsert(task) {
    set((state) => ({
      tasks: [task, ...state.tasks.filter((item) => item.id !== task.id)].sort((a, b) =>
        b.startedAt.localeCompare(a.startedAt)
      )
    }))
  },

  async applyState(event) {
    // 状态事件只带增量，完整记录回读一次，避免两处拼装出两个真相
    const task = await window.shx.task.get(event.taskId).catch(() => null)
    if (task) get().upsert(task)
  },

  applyProgress(event) {
    set((state) => ({ progress: { ...state.progress, [event.taskId]: event } }))
  }
}))

export function subscribeTaskEvents(): () => void {
  const offState = window.shx.task.onState((event) => {
    void useTaskStore.getState().applyState(event)
  })
  const offProgress = window.shx.task.onProgress((event) => {
    useTaskStore.getState().applyProgress(event)
  })
  return () => {
    offState()
    offProgress()
  }
}
