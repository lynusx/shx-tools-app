import { describe, expect, it } from 'vitest'
import {
  assertTransition,
  canTransition,
  isResumable,
  isTerminal
} from '../../electron/core/task/task-state'

describe('任务状态机', () => {
  it('扫描任务从 preparing 直接到 succeeded，不经过 running', () => {
    expect(canTransition('created', 'preparing')).toBe(true)
    expect(canTransition('preparing', 'succeeded')).toBe(true)
    expect(isTerminal('succeeded')).toBe(true)
  })

  it('复制任务走 preparing → running → succeeded', () => {
    expect(canTransition('preparing', 'running')).toBe(true)
    expect(canTransition('running', 'succeeded')).toBe(true)
  })

  it('终态不可逆', () => {
    expect(canTransition('succeeded', 'running')).toBe(false)
    expect(canTransition('failed', 'preparing')).toBe(false)
    expect(canTransition('canceled', 'paused')).toBe(false)
    expect(() => assertTransition('succeeded', 'running')).toThrow('非法任务状态迁移')
  })

  it('paused / interrupted 可继续，但不占并发名额', () => {
    expect(isResumable('paused')).toBe(true)
    expect(isResumable('interrupted')).toBe(true)
    expect(isTerminal('paused')).toBe(false)
    expect(canTransition('paused', 'preparing')).toBe(true)
    expect(canTransition('interrupted', 'preparing')).toBe(true)
  })

  it('取消是单向的：paused 可以取消，canceled 不能回到任何状态', () => {
    expect(canTransition('paused', 'canceled')).toBe(true)
    expect(canTransition('canceled', 'preparing')).toBe(false)
  })
})
