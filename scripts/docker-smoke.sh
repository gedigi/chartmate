#!/usr/bin/env bash
# Smoke test for the Chartmate Docker image: runs it the hardened way (read-only root filesystem, all
# capabilities dropped, fixture providers, a throwaway volume), waits for the image's own healthcheck, checks
# the API and the web UI, then stops it and checks that it shut down cleanly. Removes everything it created.
#
#   scripts/docker-smoke.sh <image> [host-port]
set -euo pipefail

image="${1:?usage: scripts/docker-smoke.sh <image> [host-port]}"
port="${2:-18787}"
name="chartmate-smoke-$$"
volume="chartmate-smoke-$$"

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  docker logs "$name" >&2 || true
  exit 1
}

docker volume create "$volume" >/dev/null
docker run -d --name "$name" \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -e CHARTMATE_PROVIDERS=fixture -e TZ=Asia/Tokyo \
  -v "$volume:/data" -p "127.0.0.1:$port:8787" \
  --health-interval 2s --health-start-period 30s \
  "$image" >/dev/null

echo "waiting for the healthcheck..."
for _ in $(seq 1 60); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$name")"
  [ "$status" = healthy ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ] || fail "container exited"
  sleep 1
done
[ "$status" = healthy ] || fail "healthcheck status: $status"

[ "$(docker inspect -f '{{.Config.User}}' "$name")" = node ] || fail "image does not run as the node user"

base="http://127.0.0.1:$port"
curl -fsS "$base/api/health" | grep -q '"ok":true' || fail "/api/health"
curl -fsS "$base/" | grep -qi '<div id="root"' || fail "web UI index"
curl -fsS "$base/api/bars?symbol=stock:AAPL&tf=1D&session=rth&from=1704067200000&to=1735689600000" \
  | grep -q '"bars":\[{' || fail "/api/bars returned no bars"
curl -fsS -X PUT -H 'content-type: application/json' --data '[]' "$base/api/watchlist" >/dev/null \
  || fail "write to the database on /data"

echo "stopping (SIGTERM)..."
start=$(date +%s)
docker stop -t 20 "$name" >/dev/null
elapsed=$(( $(date +%s) - start ))
code="$(docker inspect -f '{{.State.ExitCode}}' "$name")"
[ "$code" = 0 ] || fail "exit code after docker stop: $code"
[ "$elapsed" -lt 10 ] || fail "shutdown took ${elapsed}s"
docker logs "$name" 2>&1 | grep -q 'SIGTERM received' || fail "no graceful shutdown in the logs"

echo "OK: $image is healthy, serves the API and the web UI, writes only /data and stops cleanly (${elapsed}s)"
