import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
  fsyncSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
const entry = z.object({
  day: z.string(),
  reservedWei: z.string().regex(/^\d+$/),
  errors: z.number().int().nonnegative(),
  pending: z
    .object({
      hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      nonce: z.number().int().nonnegative(),
      id: z.string(),
      historyRequired: z.boolean().optional(),
    })
    .optional(),
});
const schema = z.record(z.string(), entry);
export type Entry = z.infer<typeof entry>;
export class Journal {
  private state: z.infer<typeof schema>;
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    try {
      this.state = schema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = {};
    }
  }
  pendingAccounts(): string[] {
    return Object.entries(this.state)
      .filter(([, value]) => value.pending !== undefined)
      .map(([key]) => key);
  }
  get(key: string): Entry {
    return (
      this.state[key] ?? {
        day: new Date().toISOString().slice(0, 10),
        reservedWei: "0",
        errors: 0,
      }
    );
  }
  set(key: string, value: Entry): void {
    const nextState = { ...this.state, [key]: entry.parse(value) };
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(nextState, null, 2), { mode: 0o600 });
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
    // Persist the renamed directory entry before permitting a network broadcast.
    const directory = openSync(dirname(this.path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    // Failed persistence must not release a pending hash only in memory.
    this.state = nextState;
  }
  reserve(
    key: string,
    hash: `0x${string}`,
    nonce: number,
    id: string,
    cost: bigint,
    maximum: bigint,
    historyRequired = false,
  ): void {
    const e = this.get(key);
    if (e.pending)
      throw new Error("Pending transaction requires reconciliation");
    const day = new Date().toISOString().slice(0, 10);
    const spent = e.day === day ? BigInt(e.reservedWei) : 0n;
    if (spent + cost > maximum) throw new Error("Daily gas budget exhausted");
    this.set(key, {
      ...e,
      day,
      reservedWei: (spent + cost).toString(),
      pending: { hash, nonce, id, historyRequired },
    });
  }
}
export function acquireLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "wx", 0o600);
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  return () => unlinkSync(path);
}
