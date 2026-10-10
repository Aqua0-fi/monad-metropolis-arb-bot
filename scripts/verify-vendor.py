#!/usr/bin/env python3
"""Reject edits to the vendored, test-only Aqua0 source snapshot."""
import hashlib
import json
from pathlib import Path

root = Path("vendor/aqua0")
manifest = json.loads((root / "provenance.json").read_text())
for name, digest in manifest["sha256"].items():
    if hashlib.sha256((root / name).read_bytes()).hexdigest() != digest:
        raise RuntimeError(f"Aqua0 source digest mismatch: {name}")
print("Aqua0 test source verified at " + manifest["commit"])
