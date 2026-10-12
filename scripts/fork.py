#!/usr/bin/env python3
"""Pin a real block, execute fork tests, and persist redacted evidence."""
import argparse
import hashlib
import json
import os
import re
import subprocess
import time
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--chain", type=int, default=8453)
parser.add_argument("--block", type=int)
parser.add_argument("--venue-index", type=int, default=0)
parser.add_argument("--pair-fixture", type=Path, help="Test-only JSON pair fixture under config/")
args = parser.parse_args()
pair_fixture = None
pair_suffix = ""
if args.pair_fixture:
    resolved = args.pair_fixture.resolve()
    if not resolved.is_relative_to(Path("config").resolve()) or resolved.suffix != ".json":
        parser.error("Pair fixture must be a JSON file inside config/")
    pair_fixture = json.loads(resolved.read_text())
    if pair_fixture.get("chainId") != args.chain:
        parser.error("Pair fixture belongs to a different chain")
    pair_suffix = "-" + re.sub(r"[^a-zA-Z0-9_-]", "_", resolved.stem)


chains = json.loads(Path("config/chains.json").read_text())["chains"]
index = next((i for i, chain in enumerate(chains) if chain["chainId"] == args.chain), None)
if index is None:
    parser.error("Unknown chain")
chain = chains[index]
if not 0 <= args.venue_index < len(chain["venues"]):
    parser.error("Unknown venue index")
rpc = os.environ.get(chain["rpcEnv"], chain["publicRpc"])


def call(method, params):
    result = subprocess.run(
        ["cast", "rpc", "--rpc-url", rpc, method, *[json.dumps(p) for p in params]],
        capture_output=True,
        text=True,
        timeout=45,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.replace(rpc, "<RPC_URL>"))
    return json.loads(result.stdout)


if int(call("eth_chainId", []), 16) != args.chain:
    raise RuntimeError("RPC chain mismatch")
block = args.block or int(call("eth_blockNumber", []), 16) - 10
header = call("eth_getBlockByNumber", [hex(block), False])
if not header:
    raise RuntimeError("Pinned block is unavailable")
env = os.environ.copy()
env.update(
    FORK_RPC_URL=rpc,
    FORK_BLOCK=str(block),
    FORK_CHAIN_INDEX=str(index),
    FORK_VENUE_INDEX=str(args.venue_index),
)
if args.pair_fixture:
    env["FORK_PAIR_FIXTURE"] = str(args.pair_fixture)
else:
    env.pop("FORK_PAIR_FIXTURE", None)  # Default proof cannot inherit an unrelated pair.
start = time.monotonic()
result = subprocess.run(
    ["forge", "test", "--match-path", "contracts/test/MarketRebalancer.fork.t.sol", "-vv"],
    env=env,
    text=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
)
output = result.stdout.replace(rpc, "<RPC_URL>")
path = Path(f"evidence/fork-{args.chain}-{block}-venue{args.venue_index}{pair_suffix}")
path.parent.mkdir(exist_ok=True)
path.with_suffix(".txt").write_text(output)
report = {
    "chainId": args.chain,
    "venue": chain["venues"][args.venue_index]["name"],
    "block": block,
    "blockHash": header["hash"],
    "blockTimestamp": int(header["timestamp"], 16),
    "exitCode": result.returncode,
    "elapsedSeconds": round(time.monotonic() - start, 2),
    "fixture": "Real chain state and external venues; local Aqua0 vaults, signed JIT hook, seeded mispricing and test capital",
    "harnessSha256": hashlib.sha256(Path("contracts/test/MarketRebalancer.fork.t.sol").read_bytes()).hexdigest(),
    "pairFixture": pair_fixture,
    "pairFixtureSha256": hashlib.sha256(args.pair_fixture.read_bytes()).hexdigest() if args.pair_fixture else None,
    "tests": re.findall(r"\[(?:PASS|FAIL[^\]]*)\].*", output),
}
path.with_suffix(".json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
print(output[-12000:])
raise SystemExit(result.returncode)
