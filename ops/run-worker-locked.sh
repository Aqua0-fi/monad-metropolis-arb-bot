#!/bin/sh
set -eu
# Docker's entrypoint holds an OS flock across exec. A killed container cannot leave that
# kernel lock held, unlike a PID metadata file. Every production replica uses this entrypoint.
# Only after taking that exclusive flock may we remove metadata left by our previous crash.
if [ -L /app/runtime/worker.lock ]; then
  printf '%s\n' 'Refusing a symlinked worker metadata lock' >&2
  exit 1
fi
rm -f -- /app/runtime/worker.lock
exec "$@"
