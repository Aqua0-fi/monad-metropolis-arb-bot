/** Latest-state work queues. Notifications never create an unbounded historical block backlog. */
export interface ObservedHead {
  number: bigint;
  hash: `0x${string}`;
  parentHash: `0x${string}`;
}
export interface ScanTask {
  readonly head: ObservedHead;
  readonly signal: AbortSignal;
  /** Call again before reserving, signing and broadcasting. Does not erase a pending transaction. */
  assertCurrent(): void;
  /** A read/requote may outlive its prior quote, but never its task, permission epoch or stop signal. */
  assertActive(): void;
  /** Any newer chain state invalidates queued prices, including shared-vault and external-pool changes. */
  acceptsSnapshot(number: bigint, hash: `0x${string}`): boolean;
  queueRevision(): string;
  /** A bounded provisional quote may begin fresh checking; it never authorizes transmission. */
  adoptQuote(number: bigint, hash: `0x${string}`): void;
  bindSnapshot(number: bigint, hash: `0x${string}`): void;
  /** Only for a completed exact-call proof: retain the configured block bound without requiring a stationary head. */
  bindExecutionSnapshot(number: bigint, hash: `0x${string}`): void;
}
interface Slot {
  head: ObservedHead;
  observedAt: number;
  epoch: number;
  pending: boolean;
  queued: boolean;
  running: AbortController | null;
  started: number;
  completed: number;
  coalesced: number;
  discarded: number;
  failures: number;
  lastDurationMs: number;
  lastStartDelayMs: number;
  durations: number[];
  startDelays: number[];
}
export class ObsoleteScan extends Error {
  constructor(message = "Obsolete scan cannot reserve, sign or broadcast") {
    super(message);
    this.name = "ObsoleteScan";
  }
}
export interface SchedulerOptions {
  maxConcurrent: number;
  maxBlockLag: number;
  maxTaskMs: number;
  run(chainId: number, task: ScanTask): Promise<void | false>;
  onError?(chainId: number, error: unknown): void;
  now?(): number;
}
export class LatestHeadScheduler {
  private readonly slots = new Map<number, Slot>();
  private readonly ready: number[] = [];
  private readonly waiters: (() => void)[] = [];
  private readonly now: () => number;
  private stopped = false;
  private active = 0;
  constructor(private readonly options: SchedulerOptions) {
    if (
      !Number.isInteger(options.maxConcurrent) ||
      options.maxConcurrent < 1 ||
      options.maxConcurrent > 32 ||
      !Number.isInteger(options.maxBlockLag) ||
      options.maxBlockLag < 0 ||
      options.maxTaskMs <= 0 ||
      !Number.isFinite(options.maxTaskMs)
    ) {
      throw new Error("Invalid scheduler bounds");
    }
    this.now = options.now ?? performance.now.bind(performance);
  }
  notify(chainId: number, head: ObservedHead, force = false): void {
    if (this.stopped) return;
    if (
      !Number.isSafeInteger(chainId) ||
      chainId <= 0 ||
      head.number < 0n ||
      !/^0x[0-9a-fA-F]{64}$/.test(head.hash) ||
      !/^0x[0-9a-fA-F]{64}$/.test(head.parentHash)
    )
      throw new Error("Invalid chain header");
    let slot = this.slots.get(chainId);
    if (!slot) {
      slot = {
        head,
        observedAt: this.now(),
        epoch: 0,
        pending: true,
        queued: false,
        running: null,
        started: 0,
        completed: 0,
        coalesced: 0,
        discarded: 0,
        failures: 0,
        lastDurationMs: 0,
        lastStartDelayMs: 0,
        durations: [],
        startDelays: [],
      };
      this.slots.set(chainId, slot);
    } else {
      const same =
        head.number === slot.head.number && head.hash === slot.head.hash;
      if (same && !force) return;
      const reorg =
        !same &&
        (head.number <= slot.head.number ||
          (head.number === slot.head.number + 1n &&
            head.parentHash !== slot.head.hash));
      if (reorg || force) {
        slot.epoch++;
        slot.running?.abort(
          new ObsoleteScan(
            reorg
              ? "Reorg invalidated this scan"
              : "Saved permissions or shared availability changed",
          ),
        );
      }
      if (slot.pending || slot.running) slot.coalesced++;
      slot.head = head;
      slot.observedAt = this.now();
      slot.pending = true;
    }
    if (!slot.running && !slot.queued) {
      slot.queued = true;
      this.ready.push(chainId);
    }
    this.pump();
  }
  private pump(): void {
    while (
      !this.stopped &&
      this.active < this.options.maxConcurrent &&
      this.ready.length
    ) {
      const chainId = this.ready.shift()!;
      const slot = this.slots.get(chainId)!;
      slot.queued = false;
      if (!slot.pending || slot.running) continue;
      slot.pending = false;
      const controller = new AbortController();
      slot.running = controller;
      const head = slot.head,
        epoch = slot.epoch,
        startedAt = this.now();
      slot.started++;
      this.active++;
      const startDelay = Math.max(0, startedAt - slot.observedAt);
      let skipped = false;
      let reference = head;
      const active = () =>
        !this.stopped &&
        !controller.signal.aborted &&
        slot.epoch === epoch &&
        this.now() - startedAt < this.options.maxTaskMs;
      const assertActive = () => {
        if (!active())
          throw new ObsoleteScan(
            "Scan stopped, invalidated or time budget expired",
          );
      };
      const accepts = (number: bigint, hash: `0x${string}`) =>
        active() &&
        (number > slot.head.number ||
          (number === slot.head.number && hash === slot.head.hash));
      const task: ScanTask = {
        head,
        signal: controller.signal,
        assertActive,
        acceptsSnapshot: accepts,
        queueRevision: () =>
          `${slot.epoch}:${slot.head.number}:${slot.head.hash}`,
        adoptQuote: (number, hash) => {
          assertActive();
          if (
            this.stopped ||
            controller.signal.aborted ||
            slot.epoch !== epoch ||
            (number < slot.head.number &&
              slot.head.number - number > BigInt(this.options.maxBlockLag)) ||
            (number === slot.head.number && hash !== slot.head.hash)
          )
            throw new ObsoleteScan(
              "Provisional quote is outside current-state bounds",
            );
          reference = { number, hash, parentHash: head.parentHash };
        },
        bindSnapshot: (number, hash) => {
          assertActive();
          if (!accepts(number, hash))
            throw new ObsoleteScan(
              "Shared chain state changed before the fresh quote was ready",
            );
          reference = { number, hash, parentHash: head.parentHash };
        },
        bindExecutionSnapshot: (number, hash) => {
          assertActive();
          if (
            (number < slot.head.number &&
              slot.head.number - number > BigInt(this.options.maxBlockLag)) ||
            (number === slot.head.number && hash !== slot.head.hash)
          )
            throw new ObsoleteScan(
              "Execution simulation is outside current-state bounds",
            );
          reference = { number, hash, parentHash: head.parentHash };
        },
        assertCurrent: () => {
          assertActive();
          if (
            this.stopped ||
            controller.signal.aborted ||
            slot.epoch !== epoch ||
            this.now() - startedAt >= this.options.maxTaskMs ||
            (slot.head.number >= reference.number &&
              slot.head.number - reference.number >
                BigInt(this.options.maxBlockLag))
          ) {
            throw new ObsoleteScan();
          }
        },
      };
      const timeout = setTimeout(
        () => controller.abort(new ObsoleteScan("Scan time budget exceeded")),
        this.options.maxTaskMs,
      );
      timeout.unref();
      // Do not Promise.race a timeout then release this lane. Its underlying operation could still sign.
      void Promise.resolve()
        .then(() => this.options.run(chainId, task))
        .then(
          (result) => {
            skipped = result === false;
            if (!skipped) slot.completed++;
          },
          (error) => {
            if (error instanceof ObsoleteScan || controller.signal.aborted)
              slot.discarded++;
            else {
              slot.failures++;
              this.options.onError?.(chainId, error);
            }
          },
        )
        .finally(() => {
          clearTimeout(timeout);
          if (!skipped) {
            slot.lastStartDelayMs = startDelay;
            slot.startDelays.push(startDelay);
            if (slot.startDelays.length > 128) slot.startDelays.shift();
            slot.lastDurationMs = Math.max(0, this.now() - startedAt);
            slot.durations.push(slot.lastDurationMs);
            if (slot.durations.length > 128) slot.durations.shift();
          }
          slot.running = null;
          this.active--;
          if (slot.pending && !this.stopped && !slot.queued) {
            slot.queued = true;
            this.ready.push(chainId);
          }
          this.pump();
          if (!this.active && !this.ready.length)
            this.waiters.splice(0).forEach((resolve) => resolve());
        });
    }
  }
  status() {
    const percentile = (values: number[], fraction: number) => {
      if (!values.length) return null;
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.ceil(sorted.length * fraction) - 1]!;
    };
    return [...this.slots].map(([chainId, s]) => ({
      chainId,
      headNumber: s.head.number.toString(),
      headHash: s.head.hash,
      running: !!s.running,
      queued: s.pending,
      started: s.started,
      completed: s.completed,
      coalesced: s.coalesced,
      discarded: s.discarded,
      failures: s.failures,
      lastDurationMs: s.lastDurationMs,
      lastStartDelayMs: s.lastStartDelayMs,
      durationP50Ms: percentile(s.durations, 0.5),
      durationP95Ms: percentile(s.durations, 0.95),
      startDelayP95Ms: percentile(s.startDelays, 0.95),
    }));
  }
  drain(): Promise<void> {
    return this.active || this.ready.length
      ? new Promise((resolve) => this.waiters.push(resolve))
      : Promise.resolve();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.ready.length = 0;
    for (const slot of this.slots.values()) {
      slot.pending = false;
      slot.queued = false;
      slot.running?.abort(new ObsoleteScan("Worker stopped"));
    }
    await this.drain();
  }
}
