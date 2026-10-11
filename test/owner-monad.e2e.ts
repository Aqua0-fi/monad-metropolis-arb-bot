/**
 * End-to-end owner flow on a LOCAL anvil fork of Monad mainnet (never a real network, never KMS):
 *   deploy -> setup -> timed observe run (real worker, stub backend) -> execute runs (fake worker) -> OFF.
 * Run explicitly: node --import tsx --test test/owner-monad.e2e.ts
 * Needs anvil, python3 and the free https://rpc2.monad.xyz for forking. Kills anvil afterwards.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createPublicClient,
  erc20Abi,
  http,
  parseAbi,
  type Address,
} from "viem";
import { poolKey, poolKeyId, monadPolicySchema } from "../src/owner-monad.js";

const FORK_SOURCE = "https://rpc2.monad.xyz";
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as const;
const USDC_HOLDER = "0x659bD0BC4167BA25c62E05656F78043E7eD4a9da" as const; // WMON/USDC 0.3% pool
const TEST_OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const abi = parseAbi([
  "function owner() view returns(address)",
  "function paused() view returns(bool)",
  "function activeUntil() view returns(uint64)",
  "function operators(address) view returns(bool)",
  "function limits(address) view returns(uint256,uint256)",
  "function maxGasPrice() view returns(uint256)",
  "function aquaPools(bytes32) view returns(bool)",
  "function v3Pools(address) view returns(address,address,bool)",
]);

async function freePort() {
  const server = createServer();
  await new Promise<void>((ok, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", ok);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((ok) => server.close(() => ok()));
  return address.port;
}
function env(extra: Record<string, string> = {}) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (
      v !== undefined &&
      !/^(AWS_|MARKET_REBALANCER_|AQUA0_|RPC_URL_)/.test(k)
    )
      out[k] = v;
  return { ...out, NODE_NO_WARNINGS: "1", ...extra };
}
function run(
  args: string[],
  extra: Record<string, string> = {},
  onLine?: (line: string, child: ChildProcess) => void,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("python3", args, {
      env: env(extra),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const take = (chunk: Buffer) => {
      const text = chunk.toString();
      out += text;
      for (const line of text.split("\n")) if (line) onLine?.(line, child);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("close", (code) => resolve({ code, out }));
  });
}

test(
  "owner Monad tooling on an anvil fork leaves the executor paused with activeUntil = 0",
  { timeout: 900_000 },
  async () => {
    const source = createPublicClient({
      transport: http(FORK_SOURCE, { timeout: 15000 }),
    });
    const forkBlock = (await source.getBlockNumber()) - 5n;
    const port = await freePort();
    const rpc = `http://127.0.0.1:${port}`;
    const anvil = spawn(
      "anvil",
      [
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--fork-url",
        FORK_SOURCE,
        "--fork-block-number",
        String(forkBlock),
        "--silent",
      ],
      { stdio: "ignore" },
    );
    const tmp = mkdtempSync(join(tmpdir(), "monad-e2e-"));
    const state = join(tmp, "state");
    const secrets = join(tmp, "secrets");
    const home = join(tmp, "worker-home");
    mkdirSync(state, { mode: 0o700 });
    mkdirSync(secrets, { mode: 0o700 });
    mkdirSync(home);
    for (const [name, value] of [
      [
        "market-rebalancer-observer.json",
        { AQUA0_READ_API_KEY: "e2e-read-key" },
      ],
      [
        "market-rebalancer-operator.json",
        { AQUA0_OPERATOR_API_KEY: "e2e-operator-key" },
      ],
    ] as const) {
      writeFileSync(join(secrets, name), JSON.stringify(value), {
        mode: 0o600,
      });
      chmodSync(join(secrets, name), 0o600);
    }
    const backendRequests: string[] = [];
    const backend = createHttpServer((req, res) => {
      backendRequests.push(`${req.method} ${req.url}`);
      res
        .writeHead(503, { "content-type": "application/json" })
        .end('{"error":"e2e stub backend"}');
    });
    const apiPort = await freePort();
    await new Promise<void>((ok) => backend.listen(apiPort, "127.0.0.1", ok));
    const client = createPublicClient({
      transport: http(rpc, { timeout: 15000, retryCount: 0 }),
      cacheTime: 0,
    });
    const local = (method: string, params: unknown[]) =>
      client.request({ method, params } as never);
    const common = [
      "--rpc",
      rpc,
      "--signer",
      "anvil-test",
      "--state-dir",
      state,
    ];
    const timed = (...extra: string[]) => [
      "ops/owner-timed-run-monad.py",
      "--minutes",
      "1",
      ...common,
      "--secrets-dir",
      secrets,
      "--test-worker-home",
      home,
      ...extra,
    ];
    try {
      for (let i = 0; ; i++) {
        try {
          if ((await client.getChainId()) === 143) break;
        } catch {
          /* starting */
        }
        if (i > 200 || anvil.exitCode !== null)
          throw new Error("anvil fork did not start");
        await sleep(100);
      }
      // Seed the TEST owner with 10 USDC on the fork only.
      await local("anvil_impersonateAccount", [USDC_HOLDER]);
      await local("anvil_setBalance", [USDC_HOLDER, "0x8ac7230489e80000"]);
      await local("eth_sendTransaction", [
        {
          from: USDC_HOLDER,
          to: USDC,
          data: `0xa9059cbb${TEST_OWNER.slice(2).toLowerCase().padStart(64, "0")}${(10_000_000).toString(16).padStart(64, "0")}`,
        },
      ]);
      await local("anvil_stopImpersonatingAccount", [USDC_HOLDER]);
      // The public anvil dev account has real Monad history, so nonces are compared relative to the fork.
      const nonce0 = await client.getTransactionCount({ address: TEST_OWNER });

      // 1. Deploy: a wrong phrase signs nothing; the right one deploys paused with activeUntil = 0.
      const wrong = await run([
        "ops/owner-deploy-monad.py",
        ...common,
        "--send",
        "--test-confirm",
        "DEPLOY 14",
      ]);
      assert.equal(wrong.code, 1, wrong.out);
      assert.match(wrong.out, /Cancelled/);
      assert.equal(
        await client.getTransactionCount({ address: TEST_OWNER }),
        nonce0,
      );
      const deployed = await run([
        "ops/owner-deploy-monad.py",
        ...common,
        "--send",
        "--test-confirm",
        "DEPLOY 143",
      ]);
      assert.equal(deployed.code, 0, deployed.out);
      const executor = JSON.parse(
        readFileSync(join(state, "deployment.json"), "utf8"),
      ).meta.executor as Address;
      const read = (functionName: string, args: readonly unknown[] = []) =>
        client.readContract({
          address: executor,
          abi,
          functionName: functionName as never,
          args: args as never,
        });
      assert.equal(await read("owner"), TEST_OWNER);
      assert.equal(await read("paused"), true);
      assert.equal(await read("activeUntil"), 0n);
      const again = await run([
        "ops/owner-deploy-monad.py",
        ...common,
        "--send",
        "--test-confirm",
        "DEPLOY 143",
      ]);
      assert.match(again.out, /already recorded/);
      assert.equal(
        await client.getTransactionCount({ address: TEST_OWNER }),
        nonce0 + 1,
      );

      // 2. Setup: idempotent, funded up to the cap, still OFF.
      const setup = await run([
        "ops/owner-setup-monad.py",
        ...common,
        "--enable",
        "--test-confirm",
        "SETUP MONAD 143",
      ]);
      assert.equal(setup.code, 0, setup.out);
      const policy = monadPolicySchema.parse(
        JSON.parse(readFileSync("config/monad-owner-pilot.json", "utf8")),
      );
      const pool = policy.pools.find((p) => p.label === "usdc-usdt0")!;
      assert.equal(await read("operators", [TEST_OWNER]), true);
      assert.deepEqual(await read("limits", [USDC]), [5_000_000n, 1_000n]);
      assert.equal(await read("maxGasPrice"), 200_000_000_000n);
      assert.equal(
        await read("aquaPools", [poolKeyId(poolKey(policy, pool))]),
        true,
      );
      assert.equal(
        ((await read("v3Pools", [pool.externalPool])) as unknown[])[2],
        true,
      );
      assert.equal(
        await client.readContract({
          address: USDC,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [executor],
        }),
        5_000_000n,
      );
      assert.equal(await read("paused"), true);
      assert.equal(await read("activeUntil"), 0n);
      const nonceAfterSetup = await client.getTransactionCount({
        address: TEST_OWNER,
      });
      const setupAgain = await run([
        "ops/owner-setup-monad.py",
        ...common,
        "--enable",
        "--test-confirm",
        "SETUP MONAD 143",
      ]);
      assert.equal(setupAgain.code, 0, setupAgain.out);
      assert.equal(
        await client.getTransactionCount({ address: TEST_OWNER }),
        nonceAfterSetup,
      );

      // 3. Timed observe run, ~1 minute, REAL worker CLI with --max-runtime-ms and a stub backend: no writes.
      const started = Date.now();
      const observe = await run(
        timed("--observe", "--test-api-url", `http://127.0.0.1:${apiPort}`),
      );
      const observeMs = Date.now() - started;
      assert.equal(observe.code, 0, observe.out);
      assert.match(observe.out, /runtime_limit_reached/);
      assert.match(observe.out, /Worker exited with code 0/);
      assert(
        observeMs >= 60_000 && observeMs < 120_000,
        `observe run took ${observeMs} ms`,
      );
      assert.equal(
        await client.getTransactionCount({ address: TEST_OWNER }),
        nonceAfterSetup,
      );
      assert.equal(await read("paused"), true);
      assert.equal(await read("activeUntil"), 0n);

      // 4. Execute window, worker crashes: the window was open while it ran, and the finally path closed it.
      const crash = await run(
        timed(
          "--test-worker",
          "test/fixtures/fake-monad-worker.py",
          "--test-confirm",
          "RUN MONAD 1 MIN",
        ),
        {
          FAKE_WORKER_MODE: "crash",
        },
      );
      assert.equal(crash.code, 1, crash.out);
      const started4 = crash.out
        .split("\n")
        .find((l) => l.includes("fake_worker_started"));
      assert(started4, crash.out);
      const seen = JSON.parse(started4);
      assert.equal(seen.paused, false);
      assert(seen.activeUntil > 0);
      assert.equal(seen.allowBroadcast, true);
      assert.match(
        crash.out,
        /Verified onchain: executor paused with activeUntil = 0/,
      );
      assert.equal(await read("paused"), true);
      assert.equal(await read("activeUntil"), 0n);

      // 5. Execute window, SIGTERM to the owner command while a worker that ignores SIGTERM runs.
      const term = await run(
        timed(
          "--test-worker",
          "test/fixtures/fake-monad-worker.py",
          "--test-confirm",
          "RUN MONAD 1 MIN",
        ),
        { FAKE_WORKER_MODE: "hang" },
        (line, child) => {
          if (line.includes('"grandchild"')) child.kill("SIGTERM");
        },
      );
      assert.equal(term.code, 1, term.out);
      assert.match(term.out, /Interrupted by signal 15/);
      assert.match(term.out, /SIGKILL to its process group/);
      assert.match(
        term.out,
        /Verified onchain: executor paused with activeUntil = 0/,
      );
      assert.equal(await read("paused"), true);
      assert.equal(await read("activeUntil"), 0n);
      console.log(
        JSON.stringify({
          forkBlock: String(forkBlock),
          executor,
          observeRunMs: observeMs,
          stubBackendRequests: backendRequests.length,
          ownerTransactions:
            (await client.getTransactionCount({ address: TEST_OWNER })) -
            nonce0,
          finalPaused: await read("paused"),
          finalActiveUntil: String(await read("activeUntil")),
        }),
      );
    } finally {
      backend.close();
      if (anvil.exitCode === null) {
        anvil.kill("SIGTERM");
        await Promise.race([
          new Promise((r) => anvil.once("exit", r)),
          sleep(3000),
        ]);
        if (anvil.exitCode === null) anvil.kill("SIGKILL");
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);
