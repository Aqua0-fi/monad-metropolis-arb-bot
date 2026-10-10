import {
  erc20Abi,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { same, type ChainConfig } from "./config.js";
import { nativeCostForQuote } from "./fees.js";
import { forEachConcurrent } from "./opportunity-queue.js";

const identityAbi = parseAbi([
  "function factory() view returns(address)",
  "function getPool(address,address,uint24) view returns(address)",
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function fee() view returns(uint24)",
]);
const exactOutputAbi = parseAbi([
  "function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256,uint160,uint32,uint256)",
]);
interface ConversionPool {
  pool: Address;
  quoter: Address;
  fee: number;
}
export interface NativeFeeValue {
  tokenCost: bigint;
  conversionPool: Address | null;
  conversionQuoter: Address | null;
  conversionFee: number | null;
}

/** Same-block memoization of verified token/pool identities, never balances or authorizations. */
export function createNativeFeeValuer(
  client: PublicClient,
  chain: ChainConfig,
  wrappedNative: Address,
  baseToken: Address,
  block: { number: bigint; hash: Hex },
  preferredPool?: Address,
): (nativeCost: bigint) => Promise<NativeFeeValue> {
  if (!chain.nativeEquivalent)
    throw new Error(
      "Canonical native-fee token identity is not configured for this chain",
    );
  if (!chain.nativeCurrency)
    throw new Error("Native currency metadata is unavailable");
  const expectedDecimals =
    chain.nativeEquivalent?.decimals ?? chain.nativeCurrency.decimals;
  if (
    chain.nativeEquivalent &&
    !same(chain.nativeEquivalent.token, wrappedNative)
  )
    throw new Error("Configured token is not the canonical native equivalent");
  let decimals: Promise<void> | undefined;
  let pools: Promise<ConversionPool[]> | undefined;

  const verifyDecimals = async () => {
    const [gasDecimals, baseDecimals] = await Promise.all([
      client.readContract({
        address: wrappedNative,
        abi: erc20Abi,
        functionName: "decimals",
        blockNumber: block.number,
      }),
      same(baseToken, wrappedNative)
        ? Promise.resolve(expectedDecimals)
        : client.readContract({
            address: baseToken,
            abi: erc20Abi,
            functionName: "decimals",
            blockNumber: block.number,
          }),
    ]);
    if (gasDecimals !== expectedDecimals || baseDecimals > 36)
      throw new Error(
        "Onchain gas/base token decimals disagree with registry metadata",
      );
  };

  const discover = async (): Promise<ConversionPool[]> => {
    // A route involving the native equivalent already names a possible conversion pool.
    // Verify every identity at this block; reuse only those identities during refinement.
    if (preferredPool) {
      const read = (functionName: "factory" | "token0" | "token1" | "fee") =>
        client.readContract({
          address: preferredPool,
          abi: identityAbi,
          functionName,
          blockNumber: block.number,
        });
      const [factory, token0, token1, fee] = await Promise.all([
        read("factory"),
        read("token0"),
        read("token1"),
        read("fee"),
      ]);
      const venue = chain.venues.find(
        (v) =>
          same(v.factory, factory as Address) && v.fees.includes(fee as number),
      );
      if (
        !venue ||
        ![token0, token1].some((t) => same(t as Address, baseToken)) ||
        ![token0, token1].some((t) => same(t as Address, wrappedNative))
      )
        throw new Error(
          "Preferred fee conversion pool is not a verified reviewed pair",
        );
      const [quoterFactory, actualPool] = await Promise.all([
        client.readContract({
          address: venue.quoter,
          abi: identityAbi,
          functionName: "factory",
          blockNumber: block.number,
        }),
        client.readContract({
          address: venue.factory,
          abi: identityAbi,
          functionName: "getPool",
          args: [baseToken, wrappedNative, fee as number],
          blockNumber: block.number,
        }),
      ]);
      if (
        !same(quoterFactory, venue.factory) ||
        !same(actualPool, preferredPool)
      )
        throw new Error("Preferred fee conversion pool identity mismatch");
      return [
        { pool: preferredPool, quoter: venue.quoter, fee: fee as number },
      ];
    }
    const found: ConversionPool[] = [];
    await forEachConcurrent(chain.venues, 2, async (venue) => {
      try {
        const quoterFactory = await client.readContract({
          address: venue.quoter,
          abi: identityAbi,
          functionName: "factory",
          blockNumber: block.number,
        });
        if (!same(quoterFactory, venue.factory)) return;
      } catch {
        return;
      }
      await forEachConcurrent(venue.fees, 2, async (fee) => {
        try {
          const pool = await client.readContract({
            address: venue.factory,
            abi: identityAbi,
            functionName: "getPool",
            args: [baseToken, wrappedNative, fee],
            blockNumber: block.number,
          });
          if (same(pool, zeroAddress)) return;
          const [factory, token0, token1, actualFee] = await Promise.all([
            client.readContract({
              address: pool,
              abi: identityAbi,
              functionName: "factory",
              blockNumber: block.number,
            }),
            client.readContract({
              address: pool,
              abi: identityAbi,
              functionName: "token0",
              blockNumber: block.number,
            }),
            client.readContract({
              address: pool,
              abi: identityAbi,
              functionName: "token1",
              blockNumber: block.number,
            }),
            client.readContract({
              address: pool,
              abi: identityAbi,
              functionName: "fee",
              blockNumber: block.number,
            }),
          ]);
          if (
            !same(factory, venue.factory) ||
            actualFee !== fee ||
            same(token0, token1) ||
            ![token0, token1].some((t) => same(t, baseToken)) ||
            ![token0, token1].some((t) => same(t, wrappedNative))
          )
            return;
          found.push({ pool, quoter: venue.quoter, fee });
        } catch {
          /* An unavailable venue is not a zero-cost quote. Try another reviewed venue. */
        }
      });
    });
    if (found.length === 0)
      throw new Error("No verified native-fee conversion pool is available");
    return found;
  };

  return async (nativeCost) => {
    if (nativeCost <= 0n)
      throw new Error("A fee estimate must have a positive native cost");
    decimals ??= verifyDecimals();
    await decimals;
    const gas = nativeCostForQuote(chain, wrappedNative, nativeCost);
    let answer: NativeFeeValue | undefined;
    if (same(gas.token, baseToken)) {
      answer = {
        tokenCost: gas.amount,
        conversionPool: null,
        conversionQuoter: null,
        conversionFee: null,
      };
    } else {
      pools ??= discover();
      const quotes: (NativeFeeValue & { tokenCost: bigint })[] = [];
      await forEachConcurrent(await pools, 4, async (pool) => {
        try {
          const { result } = await client.simulateContract({
            address: pool.quoter,
            abi: exactOutputAbi,
            functionName: "quoteExactOutputSingle",
            args: [
              {
                tokenIn: baseToken,
                tokenOut: gas.token,
                amount: gas.amount,
                fee: pool.fee,
                sqrtPriceLimitX96: 0n,
              },
            ],
            blockNumber: block.number,
          });
          if (result[0] <= 0n) return;
          quotes.push({
            tokenCost: result[0],
            conversionPool: pool.pool,
            conversionQuoter: pool.quoter,
            conversionFee: pool.fee,
          });
        } catch {
          /* No fabricated conversion when a real quote fails. */
        }
      });
      quotes.sort((a, b) =>
        a.tokenCost < b.tokenCost ? -1 : a.tokenCost > b.tokenCost ? 1 : 0,
      );
      answer = quotes[0];
    }
    if (!answer)
      throw new Error("Exact-output native-fee conversion is unavailable");
    if (
      (await client.getBlock({ blockNumber: block.number })).hash !== block.hash
    )
      throw new Error("Fee valuation block is no longer canonical");
    return answer;
  };
}
