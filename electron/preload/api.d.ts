import type {
  Page,
  TaskCreateInput,
  TaskListQuery,
  TaskLogEvent,
  TaskProgressEvent,
  TaskRecord,
  TaskStateEvent
} from '@shared/task'
import type { DirRecord, FileRecord, ToolManifest } from '@shared/tool-contract'

export interface ShxApi {
  tool: {
    list(): Promise<ToolManifest[]>
  }
  task: {
    create(input: TaskCreateInput): Promise<TaskRecord>
    pause(taskId: string): Promise<{ ok: boolean }>
    resume(taskId: string): Promise<{ ok: boolean }>
    cancel(taskId: string): Promise<{ ok: boolean }>
    remove(taskId: string): Promise<{ ok: boolean }>
    get(taskId: string): Promise<TaskRecord>
    list(query?: TaskListQuery): Promise<TaskRecord[]>
    dirs(query: { taskId: string; offset?: number; limit?: number }): Promise<Page<DirRecord>>
    files(query: { taskId: string; offset?: number; limit?: number }): Promise<Page<FileRecord>>
    latestScan(toolId: string): Promise<TaskRecord | null>
    onProgress(callback: (event: TaskProgressEvent) => void): () => void
    onLog(callback: (event: TaskLogEvent) => void): () => void
    onState(callback: (event: TaskStateEvent) => void): () => void
  }
  app: {
    version(): Promise<{ version: string }>
  }
  shell: {
    openPath(path: string): Promise<{ ok: boolean; message?: string }>
  }
}

declare global {
  interface Window {
    shx: ShxApi
  }
}

export {}
