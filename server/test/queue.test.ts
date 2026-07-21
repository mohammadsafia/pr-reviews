import { describe, it, expect, vi } from 'vitest'
import { makeSerialQueue } from '../src/queue.js'

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('makeSerialQueue', () => {
  it('calls onError with the thrown error and does not reject unhandled', async () => {
    const onError = vi.fn()
    const queue = makeSerialQueue(onError)
    const err = new Error('boom')
    const d = deferred<void>()
    queue.push(async () => {
      d.resolve()
      throw err
    })
    await d.promise
    // allow the rejection/catch microtasks to flush
    await new Promise((r) => setTimeout(r, 0))
    expect(onError).toHaveBeenCalledWith(err)
  })

  it('still executes a task pushed after a rejecting task', async () => {
    const onError = vi.fn()
    const queue = makeSerialQueue(onError)
    queue.push(async () => {
      throw new Error('poison')
    })
    const d = deferred<void>()
    queue.push(async () => {
      d.resolve()
    })
    await d.promise
    await new Promise((r) => setTimeout(r, 0))
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('executes tasks strictly in push order, each starting only after the previous settles', async () => {
    const onError = vi.fn()
    const queue = makeSerialQueue(onError)
    const order: string[] = []

    const first = deferred<void>()
    const second = deferred<void>()

    queue.push(async () => {
      order.push('start-1')
      await first.promise
      order.push('end-1')
    })
    queue.push(async () => {
      order.push('start-2')
      await second.promise
      order.push('end-2')
    })

    // give the queue a chance to start task 1, but task 2 must not have started yet
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual(['start-1'])

    first.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual(['start-1', 'end-1', 'start-2'])

    second.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2'])

    expect(onError).not.toHaveBeenCalled()
  })
})
