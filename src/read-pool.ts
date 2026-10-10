/** Backpressure for optimization reads. One chain cannot monopolize every slot; selected-trade
 * refreshes outrank queued exploratory work. Signing and authorizations do not enter this queue. */
export class ReadPool {
  private active = 0;
  private readonly byGroup = new Map<string, number>();
  private readonly waiting: {
    start: () => void;
    cancel: () => void;
    priority: number;
    group: string;
  }[] = [];
  constructor(
    private readonly limit = 4,
    private readonly perGroup = 2,
  ) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 32 ||
      !Number.isInteger(perGroup) ||
      perGroup < 1
    )
      throw new Error("Invalid read concurrency");
  }
  run<T>(
    work: () => Promise<T>,
    signal?: AbortSignal,
    priority = 0,
    group = "default",
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("Read cancelled"));
        return;
      }
      const cancel = () => {
        const i = this.waiting.indexOf(entry);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(signal?.reason ?? new Error("Read cancelled"));
      };
      const entry = {
        cancel,
        priority,
        group,
        start: () => {
          signal?.removeEventListener("abort", cancel);
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          this.active++;
          this.byGroup.set(group, (this.byGroup.get(group) ?? 0) + 1);
          void Promise.resolve()
            .then(work)
            .then(resolve, reject)
            .finally(() => {
              this.active--;
              const next = (this.byGroup.get(group) ?? 1) - 1;
              if (next) this.byGroup.set(group, next);
              else this.byGroup.delete(group);
              this.pump();
            });
        },
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.waiting.push(entry);
      this.pump();
    });
  }
  private pump() {
    this.waiting.sort((a, b) => b.priority - a.priority);
    while (this.active < this.limit) {
      const next = this.waiting.findIndex(
        (item) => (this.byGroup.get(item.group) ?? 0) < this.perGroup,
      );
      if (next < 0) return;
      this.waiting.splice(next, 1)[0]!.start();
    }
  }
  status() {
    return {
      active: this.active,
      queued: this.waiting.length,
      limit: this.limit,
      perChainLimit: this.perGroup,
      selectedTradeChecksQueued: this.waiting.filter(
        (item) => item.priority > 0,
      ).length,
    };
  }
}
