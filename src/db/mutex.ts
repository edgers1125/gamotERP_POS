// A tiny FIFO async mutex. `run(fn)` waits for every earlier `run` to settle (resolve OR reject), then runs `fn`
// alone. Used to serialise all SQL on the one op-sqlite connection (an `await` inside a transaction would otherwise
// let unrelated statements run inside it) and, separately, to serialise everything that assigns device counters.
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // The chain must never reject, or the next waiter would skip straight to its rejection handler.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
