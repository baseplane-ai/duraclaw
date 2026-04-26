/**
 * PushPullQueue<T> — lifetime async iterable for streaming SDKUserMessages
 * into a single Query() prompt. See spec 102-sdk-peelback.md Reduction B.
 */
export class PushPullQueue<T> {
  private items: T[] = []
  private resolvers: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(item: T): void {
    if (this.closed) throw new Error('PushPullQueue: push after close')
    const resolver = this.resolvers.shift()
    if (resolver) resolver({ value: item, done: false })
    else this.items.push(item)
  }

  close(): void {
    this.closed = true
    for (const r of this.resolvers) r({ value: undefined, done: true })
    this.resolvers = []
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const item = this.items.shift()
      if (item !== undefined) {
        yield item
        continue
      }
      if (this.closed) return
      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.resolvers.push(resolve)
      })
      if (result.done) return
      yield result.value
    }
  }
}
