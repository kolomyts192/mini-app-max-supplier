/** Ограничение одновременных вызовов: физлицу GigaChat даёт один поток, лишние запросы ждут очереди. */
export class Semaphore {
  private active = 0;
  private readonly queue: { grant: () => void; timer: NodeJS.Timeout }[] = [];

  constructor(private readonly limit: number) {}

  get waiting(): number {
    return this.queue.length;
  }

  /** Возвращает функцию освобождения; null — место не освободилось за timeoutMs. */
  acquire(timeoutMs: number): Promise<(() => void) | null> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve) => {
      const entry = {
        grant: () => {
          clearTimeout(entry.timer);
          resolve(this.releaser());
        },
        timer: setTimeout(() => {
          this.queue.splice(this.queue.indexOf(entry), 1);
          resolve(null);
        }, Math.max(0, timeoutMs)),
      };
      this.queue.push(entry);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next.grant();
      else this.active -= 1;
    };
  }
}
