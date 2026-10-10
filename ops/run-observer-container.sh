#!/bin/sh
set -eu
. /etc/aqua0-market-rebalancer/image.env
case "$IMAGE_ID" in sha256:????????????????????????????????????????????????????????????????) ;; *) echo 'Invalid pinned image identity' >&2; exit 1 ;; esac
exec docker run --rm --init --name aqua0-market-rebalancer --label aqua0.service=market-rebalancer-service \
  --network aqua0-rebalancer-isolated --publish 127.0.0.1:9191:9091 \
  --cpus 0.50 --memory 512m --memory-swap 512m --pids-limit 128 \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,size=67108864 \
  --log-driver local --log-opt max-size=10m --log-opt max-file=3 \
  --env REBALANCER_REPORT_HOST=0.0.0.0 --env REBALANCER_REPORT_PORT=9091 \
  --env REBALANCER_RUNTIME_SECRETS_FILE=/run/secrets/observer.json \
  --env REBALANCER_HOST_HEALTH_FILE=/run/host-health/health.json \
  --env AWS_EC2_METADATA_DISABLED=true --env AWS_CONFIG_FILE=/dev/null --env AWS_SHARED_CREDENTIALS_FILE=/dev/null \
  --mount type=bind,src=/var/lib/aqua0-market-rebalancer,dst=/app/runtime \
  --mount type=bind,src=/etc/aqua0-market-rebalancer/settings.json,dst=/etc/rebalancer/settings.json,readonly \
  --mount type=bind,src=/etc/aqua0-market-rebalancer/observer.json,dst=/run/secrets/observer.json,readonly \
  --mount type=bind,src=/var/lib/aqua0-host-watchdog,dst=/run/host-health,readonly \
  "$IMAGE_ID" node dist/src/cli.js run --config /etc/rebalancer/settings.json
