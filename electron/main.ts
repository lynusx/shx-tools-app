import { app, BrowserWindow, session } from 'electron'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPC } from '@shared/ipc-channels'
import { TOOL_MANIFESTS } from '@tools/manifests'
import { runSmoke } from './app/smoke'
import { createMainWindow } from './app/window'
import { Logger } from './core/logger'
import { ConfigStore } from './core/storage/config-store'
import { TaskManager } from './core/task/task-manager'
import { TaskStore } from './core/task/task-store'
import { ToolRegistry } from './core/tool-registry'
import { registerAppChannels } from './ipc/app.channel'
import { registerTaskChannels } from './ipc/task.channel'
import { registerToolChannels } from './ipc/tool.channel'

// smoke 使用独立的 userData：必须在单实例锁之前设置，否则会和正在运行的 dev 实例抢锁
const smokeMode = process.argv.includes('--smoke') || process.env['SHX_SMOKE'] === '1'
if (smokeMode) {
  app.setPath('userData', join(tmpdir(), `shx-tools-smoke-${process.pid}`))
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData')

  const logger = new Logger(join(userData, 'logs'))
  await logger.init()

  const config = new ConfigStore(join(userData, 'config.json'))
  await config.load()
  logger.setLevel(config.current.logLevel)

  process.on('uncaughtException', (error) =>
    logger.error('主进程未捕获异常', { error: error.stack })
  )
  process.on('unhandledRejection', (reason) =>
    logger.error('主进程未处理 Promise', { reason: String(reason) })
  )

  const tools = new ToolRegistry(TOOL_MANIFESTS)
  const store = new TaskStore(join(userData, 'tasks'))
  const tasks = new TaskManager(store, tools, config, logger)
  await tasks.init()

  registerToolChannels(tools)
  registerTaskChannels(tasks)
  registerAppChannels()

  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload)
    }
  }
  if (smokeMode) {
    const code = await runSmoke(tasks)
    app.exit(code)
    return
  }

  tasks.on('state', (event) => broadcast(IPC.eventTaskState, event))
  tasks.on('progress', (event) => broadcast(IPC.eventTaskProgress, event))
  tasks.on('log', (event) => broadcast(IPC.eventTaskLog, event))

  createMainWindow()

  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
}

void app.whenReady().then(async () => {
  // 生产环境收紧 CSP；开发态 Vite HMR 需要 ws 与 inline，不在这里加
  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"
          ]
        }
      })
    })
  }

  await bootstrap()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
