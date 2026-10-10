#!/usr/bin/env python3
"""Check the exact reviewed registry bytes without requiring a backend checkout in CI."""
import hashlib
import json
from pathlib import Path

root=Path('config')
provenance=json.loads((root/'registry-provenance.json').read_text())
for filename,key in [('chains.json','generatedChainsSha256'),('execution-policies.json','executionPoliciesSha256')]:
    actual=hashlib.sha256((root/filename).read_bytes()).hexdigest()
    if actual!=provenance[key]:
        raise SystemExit(f'Registry provenance mismatch for {filename}; regenerate from the reviewed backend source')
chains=json.loads((root/'chains.json').read_text())['chains']
ids=[chain['chainId'] for chain in chains]
if ids!=provenance['chainIds'] or len(ids)!=len(set(ids)):
    raise SystemExit('Registry chain identities do not match their provenance')
print(f'Reviewed registry bytes verified for {len(ids)} chains')
