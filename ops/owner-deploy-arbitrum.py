#!/usr/bin/env python3
"""Owner-controlled wrapper. Default preview; --send requires an interactive typed confirmation."""
import argparse
import os
import shlex
import stat
import subprocess
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--send", action="store_true")
    modes.add_argument("--status", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    env = {k: v for k, v in os.environ.items() if not k.startswith(("AWS_", "MARKET_REBALANCER_", "AQUA0_"))}
    if not args.status:
        source = Path("/Users/rithikkumars/CodingStuff/Aqua0/secrets/market-rebalancer.aws.env")
        info = source.lstat()
        if source.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise RuntimeError("Credential file must be owner-only and mode 600")
        allowed = {"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "MARKET_REBALANCER_KMS_KEY_ID", "MARKET_REBALANCER_OPERATOR_ADDRESS"}
        for line in source.read_text().splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            name, value = line.split("=", 1)
            if name not in allowed:
                continue
            parts = shlex.split(value)
            if len(parts) != 1:
                raise RuntimeError("Invalid credential-file syntax")
            env[name] = parts[0]
    env.update(AWS_CONFIG_FILE="/dev/null", AWS_SHARED_CREDENTIALS_FILE="/dev/null", AWS_EC2_METADATA_DISABLED="true")
    command = ["node", "--import", "tsx", "scripts/owner-deploy-executor.ts"]
    if args.send:
        if not os.isatty(0) or not os.isatty(1):
            raise RuntimeError("Sending requires the owner at an interactive terminal")
        command.append("--send")
    elif args.status:
        command.append("--status")
    print("Owner deployment mode: " + ("interactive send, confirmation required" if args.send else "read-only status" if args.status else "preview only; no signing"), flush=True)
    return subprocess.run(command, cwd=root, env=env, check=False).returncode


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"Owner helper stopped: {type(exc).__name__}. No success is assumed; retain any existing journal.")
        raise SystemExit(1)
