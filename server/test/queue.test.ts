import { describe, it, expect, vi } from 'vitest'
import { makeTaskPool } from '../src/queue.js'

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('makeTaskPool', () => {
  it('runs at most getLimit() tasks at once and starts waiters as slots free', async () => {
    const pool = makeTaskPool(() => 2, () => {})
    const order: string[] = []
    const gates = [deferred(), deferred(), deferred()]
    for (const [i, gate] of gates.entries()) {
      pool.push(async () => {
        order.push(`start-${i}`)
        await gate.promise
        order.push(`end-${i}`)
      })
    }
    await tick()
    expect(order).toEqual(['start-0', 'start-1']) // task 2 held back by the cap
    gates[0].resolve()
    await tick()
    expect(order).toEqual(['start-0', 'start-1', 'end-0', 'start-2'])
    gates[1].resolve()
    gates[2].resolve()
    await tick()
    expect(order).toContain('end-2')
  })

  it('with limit 1 preserves strict push order (the old serial guarantee)', async () => {
    const pool = makeTaskPool(() => 1, () => {})
    const order: string[] = []
    const first = deferred()
    pool.push(async () => {
      order.push('start-1')
      await first.promise
      order.push('end-1')
    })
    pool.push(async () => {
      order.push('start-2')
    })
    await tick()
    expect(order).toEqual(['start-1'])
    first.resolve()
    await tick()
    expect(order).toEqual(['start-1', 'end-1', 'start-2'])
  })

  it('reads getLimit at each dequeue — raising it mid-stream starts more waiters', async () => {
    let limit = 1
    const pool = makeTaskPool(() => limit, () => {})
    const running: string[] = []
    const gate = deferred()
    pool.push(async () => {
      running.push('a')
      await gate.promise
    })
    pool.push(async () => {
      running.push('b')
      await gate.promise
    })
    pool.push(async () => {
      running.push('c')
      await gate.promise
    })
    await tick()
    expect(running).toEqual(['a'])
    limit = 3
    // a raised limit takes effect at the next dequeue — trigger one by pushing
    pool.push(async () => {
      running.push('d')
      await gate.promise
    })
    await tick()
    expect(running).toEqual(['a', 'b', 'c']) // cap now 3: b and c start, d waits for a slot
    gate.resolve()
    await tick()
    expect(running).toContain('d') // a slot freed → d ran
  })

  it('routes task errors to onError and keeps the pool draining', async () => {
    const onError = vi.fn()
    const pool = makeTaskPool(() => 1, onError)
    const err = new Error('boom')
    pool.push(async () => {
      throw err
    })
    const d = deferred()
    pool.push(async () => {
      d.resolve()
    })
    await d.promise
    await tick()
    expect(onError).toHaveBeenCalledWith(err)
  })

  it('guards a getLimit of 0 or less by running at least one task', async () => {
    const pool = makeTaskPool(() => 0, () => {})
    const d = deferred()
    pool.push(async () => {
      d.resolve()
    })
    await d.promise // resolves only if the task ran despite limit 0
  })
})
