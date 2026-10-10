/** Compare already-ready opportunities, not hypothetical results held behind a slow venue. */
export class ReadyOpportunityQueue<T> {
  private pending: T[] = [];
  private running: Promise<void> | undefined;
  private stopped = false;
  private error: unknown;
  private accepted: T | undefined;
  constructor(
    private readonly compare: (a: T, b: T) => number,
    private readonly attempt: (value: T) => Promise<boolean>,
    private readonly onStop: () => void,
    private readonly valid: (value: T) => boolean = () => true,
  ) {}
  offer(value: T) {
    if (this.stopped) return;
    this.pending.push(value);
    this.start();
  }
  private start() {
    if (this.running || this.stopped) return;
    this.running = Promise.resolve()
      .then(async () => {
        while (this.pending.length && !this.stopped) {
          this.pending.sort(this.compare);
          const value = this.pending.shift()!;
          if (!this.valid(value)) continue;
          if (await this.attempt(value)) {
            this.accepted = value;
            this.stopped = true;
            this.pending = [];
            this.onStop();
          }
        }
      })
      .catch((error) => {
        this.error = error;
        this.stopped = true;
        this.pending = [];
        this.onStop();
      })
      .finally(() => {
        this.running = undefined;
        if (this.pending.length && !this.stopped) this.start();
      });
  }
  async settle(): Promise<T | undefined> {
    while (this.running) await this.running;
    if (this.error !== undefined) throw this.error;
    return this.accepted;
  }
}
/** Bounded read work. Always drain started calls before propagating a failure. */
export async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let index = 0;
  let failed: unknown;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (index < items.length && !signal?.aborted) {
        const value = items[index++]!;
        try {
          await run(value);
        } catch (error) {
          failed ??= error;
        }
      }
    }),
  );
  if (failed !== undefined) throw failed;
}
