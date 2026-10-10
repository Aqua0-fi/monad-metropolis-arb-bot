import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";
import { AquaClient } from "../src/aqua.js";
import { MarketCatalog } from "../src/market-catalog.js";
import { refreshPublicMarkets } from "../src/discovery.js";
import { loadChains } from "../src/config.js";

test("periodic ordinary HTTP discovery notices a new pair without changing static config or approving it", async () => {
  const chain = loadChains().find((c) => c.chainId === 8453)!;
  let generation = 0,
    failure = false;
  const urls: string[] = [];
  const pool = (fee: number) => {
    const key = { ...chain.pools[0]!, fee };
    const poolId = keccak256(
      encodeAbiParameters(
        parseAbiParameters("address,address,uint24,int24,address"),
        [key.currency0, key.currency1, fee, key.tickSpacing, key.hooks],
      ),
    );
    return {
      ...key,
      poolId,
      poolManager: chain.poolManager,
      armedOnCurrentAdapter: true,
      sqrtPriceX96: "79228162514264337593543950336",
      aquaClass: {
        classId: generation ? "7" : null,
        paused: false,
        otherClassIds: [],
      },
    };
  };
  const server = createServer((req, res) => {
    urls.push(req.url!);
    assert.equal(req.method, "GET");
    assert.equal(req.headers["x-api-key"], "ordinary-read-test-credential");
    if (failure) {
      res.writeHead(503);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        chainId: 8453,
        rpcDegraded: false,
        pools: generation ? [pool(3000), pool(500)] : [pool(3000)],
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const client = new AquaClient(`http://127.0.0.1:${address.port}`, {
    "X-API-Key": "ordinary-read-test-credential",
  });
  const catalog = new MarketCatalog(":memory:", "mainnet", [chain]);
  try {
    assert.deepEqual(await refreshPublicMarkets([chain], client, catalog), {
      succeeded: 1,
      failed: 0,
    });
    assert.equal(catalog.list().markets.length, 1);
    assert.match(
      catalog.list().markets[0]!.blockers.join(" "),
      /class identity/,
    );
    generation++;
    await refreshPublicMarkets([chain], client, catalog);
    assert.equal(catalog.list().markets.length, 2);
    assert.equal(catalog.activeMarkets().length, 0);
    assert(catalog.list().markets.every((m) => m.policy === null));
    failure = true;
    assert.deepEqual(await refreshPublicMarkets([chain], client, catalog), {
      succeeded: 0,
      failed: 1,
    });
    assert.equal(catalog.list().markets.length, 2);
    assert.equal(catalog.list().chains[0]!.ok, false);
    assert(
      urls.every(
        (url) => url === "/api/vaults/pools?chainId=8453&includeArming=true",
      ),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    catalog.close();
  }
});
