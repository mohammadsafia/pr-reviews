export interface TaskPool {
  push(fn: () => Promise<void>): void
}

/** Runs pushed tasks with at most getLimit() in flight. getLimit is read at every dequeue
 * decision (never captured), so a config change applies to the next task start without a
 * restart. Task errors go to onError; the pool never stalls on a failed task. */
export function makeTaskPool(getLimit: () => number, onError: (err: unknown) => void): TaskPool {
  const waiting: (() => Promise<void>)[] = []
  let running = 0
  function maybeStart(): void {
    while (running < Math.max(1, getLimit()) && waiting.length > 0) {
      const fn = waiting.shift()!
      running++
      fn()
        .catch(onError)
        .finally(() => {
          running--
          maybeStart()
        })
    }
  }
  return {
    push(fn) {
      waiting.push(fn)
      maybeStart()
    },
  }
}
