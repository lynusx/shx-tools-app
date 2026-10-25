import { describe, expect, it } from 'vitest'
import { Semaphore } from '../../infra/limit'

describe('并发信号量', () => {
  it('超过上限的请求排队，释放后按序通过', async () => {
    const pool = new Semaphore(2)
    const releaseA = await pool.acquire()
    const releaseB = await pool.acquire()
    expect(pool.running).toBe(2)

    let thirdAcquired = false
    const third = pool.acquire().then((release) => {
      thirdAcquired = true
      return release
    })

    await Promise.resolve()
    expect(thirdAcquired).toBe(false)

    releaseA()
    const releaseC = await third
    expect(thirdAcquired).toBe(true)
    expect(pool.running).toBe(2)

    releaseB()
    releaseC()
    expect(pool.running).toBe(0)
  })

  it('释放两次不会多放行一个', async () => {
    const pool = new Semaphore(1)
    const release = await pool.acquire()
    release()
    release()
    expect(pool.running).toBe(0)
  })
})
