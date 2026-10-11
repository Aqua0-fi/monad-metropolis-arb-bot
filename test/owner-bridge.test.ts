import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeFunctionData, getAddress, parseEther } from "viem";
import {
  BRIDGE_MAX_WEI,
  RELAY_ARBITRUM_DEPOSITORY,
  bridgeAmount,
  relayDepositAbi,
  relayQuoteRequest,
  validateRelayQuote,
} from "../src/owner-bridge.js";

// A real Relay /quote response (0.001 ETH, Arbitrum -> Monad, KMS wallet), captured 2026-10-12.
const fixture = JSON.parse(
  readFileSync("test/fixtures/relay-quote-arbitrum-monad.json", "utf8"),
);
const owner = getAddress("0xd1fC4c8631E8C5d23a0C86D5890802DD70Cb4cf5");
const other = "0x1111111111111111111111111111111111111111";
const amountWei = parseEther("0.001");
const nowSeconds = 1_791_760_000;
const clone = () => JSON.parse(JSON.stringify(fixture));
const item = (q: any) => q.steps[0].items[0].data;

test("a real Relay quote validates to one depositNative from and to the KMS wallet on chain 143", () => {
  const v = validateRelayQuote(fixture, { owner, amountWei, nowSeconds });
  assert.equal(v.chainId, 42161);
  assert.equal(v.destinationChainId, 143);
  assert.equal(v.recipient, owner);
  assert.equal(v.to, RELAY_ARBITRUM_DEPOSITORY);
  assert.equal(v.value, amountWei);
  assert(v.minimumOutWei > 0n && v.expectedOutWei >= v.minimumOutWei);
  const call = decodeFunctionData({ abi: relayDepositAbi, data: v.data });
  assert.deepEqual(call.args, [owner, fixture.protocol.v2.orderId]);
  assert(v.fees.some((f) => f.name === "relayer"));
  assert.deepEqual(relayQuoteRequest(owner, amountWei), {
    user: owner,
    recipient: owner,
    originChainId: 42161,
    destinationChainId: 143,
    originCurrency: "0x0000000000000000000000000000000000000000",
    destinationCurrency: "0x0000000000000000000000000000000000000000",
    amount: "1000000000000000",
    tradeType: "EXACT_INPUT",
  });
});

test("any destination other than the KMS wallet on Monad, or a changed deposit, is refused", () => {
  const cases: [string, (q: any) => void, RegExp][] = [
    [
      "recipient",
      (q) => (q.protocol.v2.orderData.output.payments[0].recipient = other),
      /recipient/,
    ],
    ["details recipient", (q) => (q.details.recipient = other), /recipient/],
    [
      "destination chain",
      (q) => (q.protocol.v2.orderData.output.chainId = "base"),
      /Monad/,
    ],
    [
      "details chain",
      (q) => (q.details.currencyOut.currency.chainId = 8453),
      /chain 143/,
    ],
    [
      "destination token",
      (q) => (q.details.currencyOut.currency.address = other),
      /MON/,
    ],
    [
      "destination call",
      (q) =>
        (q.protocol.v2.orderData.output.calls = [{ to: other, data: "0x" }]),
      /calls/,
    ],
    [
      "refund",
      (q) => (q.protocol.v2.orderData.inputs[0].refunds[1].recipient = other),
      /refund/,
    ],
    ["target", (q) => (item(q).to = other), /depository/],
    ["sender", (q) => (item(q).from = other), /sender/],
    ["source chain", (q) => (item(q).chainId = 1), /Arbitrum/],
    ["value", (q) => (item(q).value = "2000000000000000"), /value/],
    [
      "calldata",
      (q) =>
        (item(q).data = item(q).data.replace(
          owner.slice(2).toLowerCase(),
          other.slice(2),
        )),
      /calldata/,
    ],
    [
      "extra step",
      (q) => q.steps.unshift({ id: "approve", kind: "transaction", items: [] }),
      /one step/,
    ],
    [
      "two txs",
      (q) => q.steps[0].items.push(q.steps[0].items[0]),
      /one deposit/,
    ],
    [
      "min out",
      (q) => {
        q.protocol.v2.orderData.output.payments[0].minimumAmount =
          "1000000000000000000";
        q.details.currencyOut.minimumAmount = "1000000000000000000";
      },
      /90%/,
    ],
    [
      "consistency",
      (q) => (q.details.currencyOut.minimumAmount = "1"),
      /disagrees/,
    ],
    [
      "expiry",
      (q) => (q.protocol.v2.orderData.output.deadline = nowSeconds + 30),
      /expires/,
    ],
  ];
  for (const [name, mutate, expected] of cases) {
    const q = clone();
    mutate(q);
    assert.throws(
      () => validateRelayQuote(q, { owner, amountWei, nowSeconds }),
      expected,
      name,
    );
  }
  assert.throws(() =>
    validateRelayQuote(fixture, {
      owner: getAddress(other),
      amountWei,
      nowSeconds,
    }),
  );
  assert.throws(
    () =>
      validateRelayQuote(fixture, {
        owner,
        amountWei: amountWei + 1n,
        nowSeconds,
      }),
    /value/,
  );
});

test("bridge amount is capped at 0.0015 ETH and must be a plain decimal", () => {
  assert.equal(bridgeAmount("0.001"), amountWei);
  assert.equal(bridgeAmount("0.0015"), BRIDGE_MAX_WEI);
  for (const bad of ["0.0016", "1", "0.0", "1e-3", "0.001 ", "-0.001", ".001"])
    assert.throws(() => bridgeAmount(bad), bad);
  assert.throws(() =>
    validateRelayQuote(fixture, {
      owner,
      amountWei: BRIDGE_MAX_WEI + 1n,
      nowSeconds,
    }),
  );
});
