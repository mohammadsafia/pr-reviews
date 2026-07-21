export interface SerialQueue {
  push(fn: () => Promise<void>): void
}

export function makeSerialQueue(onError: (err: unknown) => void): SerialQueue {
  let tail: Promise<void> = Promise.resolve()
  return {
    push(fn) {
      tail = tail.then(fn).catch(onError)
    },
  }
}
