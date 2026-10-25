export const ERROR_CODES = {
  PARAM_INVALID: 'E_PARAM_INVALID',
  PARAM_TOO_LARGE: 'E_PARAM_TOO_LARGE',
  TEMPLATE_INVALID: 'E_TEMPLATE_INVALID',
  TEMPLATE_NAME_TAKEN: 'E_TEMPLATE_NAME_TAKEN',
  TEMPLATE_TOOL_MISMATCH: 'E_TEMPLATE_TOOL_MISMATCH',
  FS_NOT_FOUND: 'E_FS_NOT_FOUND',
  FS_PERM: 'E_FS_PERM',
  FS_DISK_FULL: 'E_FS_DISK_FULL',
  FS_BUSY: 'E_FS_BUSY',
  NET_UNREACHABLE: 'E_NET_UNREACHABLE',
  NET_TIMEOUT: 'E_NET_TIMEOUT',
  NET_DENIED: 'E_NET_DENIED',
  LNK_BROKEN: 'E_LNK_BROKEN',
  LNK_CONFLICT: 'E_LNK_CONFLICT',
  WORKER_TIMEOUT: 'E_WORKER_TIMEOUT',
  WORKER_CRASH: 'E_WORKER_CRASH',
  WORKER_DATA_LOSS: 'E_WORKER_DATA_LOSS',
  UNKNOWN: 'E_UNKNOWN'
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/** 跨进程传递的错误形状：只放纯数据，不进 Error 实例 */
export interface TaskError {
  code: ErrorCode
  message: string
  stack?: string
}

export function makeTaskError(
  error: unknown,
  fallback: ErrorCode = ERROR_CODES.UNKNOWN
): TaskError {
  if (error instanceof Error) {
    return { code: fallback, message: error.message, stack: error.stack }
  }
  if (typeof error === 'string') {
    return { code: fallback, message: error }
  }
  return { code: fallback, message: '未知错误' }
}
