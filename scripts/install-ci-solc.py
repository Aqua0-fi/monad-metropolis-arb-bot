#!/usr/bin/env python3
"""Provision the two exact verified Linux compiler releases in Foundry's local cache."""
import hashlib
import os
from pathlib import Path
import platform
import subprocess
import tempfile
import urllib.request

# Cross-checked against the official Solidity binary list and release asset digests.
# 0.8.34 is ONLY for pinned legacy protocol fixtures; the executor uses 0.8.37.
RELEASES = {
    '0.8.34': ('80d5c536', 'd40adc6f9fdbb22a97d32a02fa05688bf2ee7886affc48c9851b0afd4a726b39'),
    '0.8.37': ('f401782d', '5de843c2c93563cc66425c99a4fb13fdbf32b4c4ae07469480faaf126e14404a'),
}


def verify(data: bytes, expected: str) -> None:
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError('Compiler SHA256 differs from the reviewed official release')


def install(target: Path, expected: str, url: str) -> None:
    if target.is_symlink() or target.parent.is_symlink():
        raise ValueError('Compiler cache must not redirect through a symlink')
    if target.exists():
        verify(target.read_bytes(), expected)
        return
    request = urllib.request.Request(url, headers={'User-Agent': 'Aqua0 verified CI compiler installer'})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read(32 * 1024 * 1024 + 1)
    if len(data) > 32 * 1024 * 1024:
        raise ValueError('Compiler download exceeded the expected size bound')
    verify(data, expected)  # No unverified bytes may become executable.
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=target.parent, prefix='.verified-solc-')
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o700)
        os.link(temporary, target)  # Never overwrite a concurrently installed compiler.
    finally:
        os.unlink(temporary)


def main() -> None:
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'AMD64'):
        raise SystemExit('This installer is only for the Linux x86-64 CI runner')
    root = Path.home() / '.svm'
    if root.is_symlink():
        raise SystemExit('Compiler cache root must not be a symlink')
    for version, (commit, digest) in RELEASES.items():
        binary = root / version / f'solc-{version}'
        install(binary, digest, f'https://github.com/argotorg/solidity/releases/download/v{version}/solc-static-linux')
        output = subprocess.check_output([str(binary), '--version'], text=True, timeout=10)
        if f'{version}+commit.{commit}' not in output:
            raise RuntimeError('Compiler reports an unexpected version despite the pinned checksum')
        print(f'Verified Solidity {version}+commit.{commit}: sha256:{digest}')


if __name__ == '__main__':
    main()
