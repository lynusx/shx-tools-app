import { app, shell } from 'electron'
import { z } from 'zod'
import { IPC } from '@shared/ipc-channels'
import { register } from './router'

export function registerAppChannels(): void {
  register(IPC.appVersion, null, () => ({ version: app.getVersion() }))

  register(IPC.shellOpenPath, z.object({ path: z.string().min(1) }), async ({ path }) => {
    const message = await shell.openPath(path)
    return message ? { ok: false, message } : { ok: true }
  })
}
