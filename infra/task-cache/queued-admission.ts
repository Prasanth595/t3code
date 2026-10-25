// @effect-diagnostics globalTimers:off - standalone Worker deadline; no Effect runtime.
// Preserve upstream's memory limits while letting ordinary task batches wait.
export class Admission {
  private unavailable: () => Error;

  constructor(unavailable: () => Error = () => new Error("concurrency_limit")) {
    this.unavailable = unavailable;
  }

  private active = [0, 0];
  private waiting: Array<Array<() => void>> = [[], []];

  async acquire(store: boolean): Promise<() => void> {
    const index = store ? 0 : 1;
    const limit = store ? 2 : 4;
    const queue = this.waiting[index]!;
    if (this.active[index]! >= limit) {
      if (queue.length >= 64) throw this.unavailable();
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          queue.splice(queue.indexOf(ready), 1);
          reject(this.unavailable());
        }, 120_000);
        queue.push(ready);
      });
    } else {
      this.active[index]!++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = queue.shift();
      if (next) next();
      else this.active[index]!--;
    };
  }
}
