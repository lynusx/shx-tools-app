import { z } from 'zod'
import { IPC } from '@shared/ipc-channels'
import type { TaskCreateInput } from '@shared/task'
import type { TaskManager } from '../core/task/task-manager'
import { register } from './router'

const kindSchema = z.enum(['scan', 'copy'])

const createSchema = z.object({
  toolId: z.string().min(1),
  kind: kindSchema,
  params: z.record(z.string(), z.unknown())
})

const idSchema = z.object({ taskId: z.string().min(1) })

const listSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
  kind: kindSchema.optional()
})

const pageSchema = z.object({
  taskId: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(1000).optional()
})

const latestScanSchema = z.object({ toolId: z.string().min(1) })

export function registerTaskChannels(tasks: TaskManager): void {
  register<TaskCreateInput, unknown>(IPC.taskCreate, createSchema, (input) => tasks.create(input))
  register(IPC.taskPause, idSchema, ({ taskId }) => tasks.pause(taskId).then(() => ({ ok: true })))
  register(IPC.taskResume, idSchema, ({ taskId }) =>
    tasks.resume(taskId).then(() => ({ ok: true }))
  )
  register(IPC.taskCancel, idSchema, ({ taskId }) =>
    tasks.cancel(taskId).then(() => ({ ok: true }))
  )
  register(IPC.taskRemove, idSchema, ({ taskId }) =>
    tasks.remove(taskId).then(() => ({ ok: true }))
  )
  register(IPC.taskGet, idSchema, ({ taskId }) => tasks.get(taskId))
  register(IPC.taskList, listSchema, (query) => tasks.list(query))
  register(IPC.taskDirs, pageSchema, ({ taskId, offset, limit }) =>
    tasks.dirs(taskId, offset, limit)
  )
  register(IPC.taskFiles, pageSchema, ({ taskId, offset, limit }) =>
    tasks.files(taskId, offset, limit)
  )
  register(IPC.taskLatestScan, latestScanSchema, ({ toolId }) => tasks.latestScan(toolId))
}
