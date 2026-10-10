#!/usr/bin/env python3
"""Owner-invoked read-only Arbitrum fixture capture. No KMS or transaction transport."""
import json
import os
import stat
import subprocess
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    source = Path("/Users/rithikkumars/CodingStuff/Aqua0/secrets/market-rebalancer-observer.json")
    info = source.lstat()
    if source.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise RuntimeError("Credential file must be an owner-only regular file with mode 600")
    data = json.loads(source.read_text())
    key = data.get("AQUA0_READ_API_KEY")
    if not isinstance(key, str) or len(key) < 16:
        raise RuntimeError("The dedicated read API key is missing")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("AWS_", "MARKET_REBALANCER_", "AQUA0_"))}
    env["AQUA0_API_KEY"] = key
    print("Reading Arbitrum production strategy, vault capacity and external pool. No signing or transactions.", flush=True)
    result = subprocess.run(
        ["node", "--import", "tsx", "scripts/capture-production-maker.ts", "--chain", "42161", "--output", "config/production-maker-arbitrum-fork.json"],
        cwd=root, env=env, capture_output=True, text=True, timeout=240,
    )
    # Never echo a credential even if an unexpected dependency includes it in its error.
    stdout = result.stdout.replace(key, "<redacted>")
    stderr = result.stderr.replace(key, "<redacted>")
    if result.returncode:
        print("Capture did not complete; no public transaction was sent.")
        for line in stderr.splitlines():
            if "Error:" in line:
                print(line[:500])
    else:
        print(stdout)
        print("Saved the read-only fixture. Leave the terminal output available for review.")
    return result.returncode


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        print(f"Read-only capture stopped: {type(exc).__name__}. No KMS signing or transaction submission occurred.")
        raise SystemExit(1)
