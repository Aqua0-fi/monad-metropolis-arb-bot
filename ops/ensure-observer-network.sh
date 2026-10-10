#!/bin/sh
set -eu
NETWORK=aqua0-rebalancer-isolated
BRIDGE=br-rebalancer
SUBNET=172.30.91.0/28
if docker network inspect "$NETWORK" >/dev/null 2>&1; then
  test "$(docker network inspect --format '{{index .Labels "aqua0.service"}}' "$NETWORK")" = market-rebalancer-service
  test "$(docker network inspect --format '{{(index .IPAM.Config 0).Subnet}}' "$NETWORK")" = "$SUBNET"
  test "$(docker network inspect --format '{{.EnableIPv6}}' "$NETWORK")" = false
else
  docker network create --subnet "$SUBNET" --opt com.docker.network.bridge.name="$BRIDGE" --label aqua0.service=market-rebalancer-service "$NETWORK" >/dev/null
fi
# Only this new bridge is affected. The existing instance profile must not leak into the worker.
iptables -w 5 -S DOCKER-USER >/dev/null
iptables -w 5 -C DOCKER-USER -i "$BRIDGE" -d 169.254.0.0/16 -m comment --comment aqua0-rebalancer-imds -j REJECT 2>/dev/null ||
  iptables -w 5 -I DOCKER-USER 1 -i "$BRIDGE" -d 169.254.0.0/16 -m comment --comment aqua0-rebalancer-imds -j REJECT
