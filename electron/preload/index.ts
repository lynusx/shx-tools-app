import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { TaskCreateInput, TaskListQuery } from '@shared/task'
import type { ShxApi } from './api'

/** 订阅必须返回 unsubscribe：组件卸载不取消是「幽灵更新」的常见来源 */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: ShxApi = {
  tool: {
    list: () => ipcRenderer.invoke(IPC.toolList)
  },
  task: {
    create: (input: TaskCreateInput) => ipcRenderer.invoke(IPC.taskCreate, input),
    pause: (taskId) => ipcRenderer.invoke(IPC.taskPause, { taskId }),
    resume: (taskId) => ipcRenderer.invoke(IPC.taskResume, { taskId }),
    cancel: (taskId) => ipcRenderer.invoke(IPC.taskCancel, { taskId }),
    remove: (taskId) => ipcRenderer.invoke(IPC.taskRemove, { taskId }),
    get: (taskId) => ipcRenderer.invoke(IPC.taskGet, { taskId }),
    list: (query?: TaskListQuery) => ipcRenderer.invoke(IPC.taskList, query ?? {}),
    dirs: (query) => ipcRenderer.invoke(IPC.taskDirs, query),
    files: (query) => ipcRenderer.invoke(IPC.taskFiles, query),
    latestScan: (toolId) => ipcRenderer.invoke(IPC.taskLatestScan, { toolId }),
    onProgress: (callback) => subscribe(IPC.eventTaskProgress, callback),
    onLog: (callback) => subscribe(IPC.eventTaskLog, callback),
    onState: (callback) => subscribe(IPC.eventTaskState, callback)
  },
  app: {
    version: () => ipcRenderer.invoke(IPC.appVersion)
  },
  shell: {
    openPath: (path) => ipcRenderer.invoke(IPC.shellOpenPath, { path })
  }
}

contextBridge.exposeInMainWorld('shx', api)
