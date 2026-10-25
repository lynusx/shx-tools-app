/** IPC 通道名：只在这里出现字符串字面量 */
export const IPC = {
  toolList: 'tool:list',

  taskCreate: 'task:create',
  taskCancel: 'task:cancel',
  taskPause: 'task:pause',
  taskResume: 'task:resume',
  taskList: 'task:list',
  taskGet: 'task:get',
  taskRemove: 'task:remove',
  taskDirs: 'task:dirs',
  taskFiles: 'task:files',
  taskLatestScan: 'task:latestScan',

  appVersion: 'app:version',
  shellOpenPath: 'shell:openPath',

  eventTaskProgress: 'task:progress',
  eventTaskLog: 'task:log',
  eventTaskState: 'task:state'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
