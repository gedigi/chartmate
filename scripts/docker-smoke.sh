#!/usr/bin/env bash
# Smoke test for the Chartmate Docker image: runs it the hardened way (read-only root filesystem with a tmpfs
# /tmp, all capabilities dropped, fixture providers, a throwaway volume), waits for the image's own healthcheck,
# checks the API, the web UI and SQLite (including temp-file spills), then stops it and checks that it shut down
# cleanly. Removes everything it created. Works under emulation (e.g. an arm64 image on an amd64 runner).
#
#   scripts/docker-smoke.sh <image> [--platform <os/arch>]
set -euo pipefail

image="${1:?usage: scripts/docker-smoke.sh <image> [--platform <os/arch>]}"
shift
platform_args=("$@")
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

# Fetches a URL into a variable first, so a failed match never races a closed pipe.
fetch() {
  curl -fsS --max-time 20 "$@"
}

docker volume create "$volume" >/dev/null
# 127.0.0.1::8787 lets Docker pick a free host port.
docker run -d --name "$name" ${platform_args[@]+"${platform_args[@]}"} \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -e CHARTMATE_PROVIDERS=fixture -e TZ=Asia/Tokyo \
  -v "$volume:/data" -p 127.0.0.1::8787 \
  --health-interval 2s --health-start-period 60s \
  "$image" >/dev/null

echo "waiting for the healthcheck..."
status=starting
for _ in $(seq 1 120); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$name")"
  [ "$status" = healthy ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ] || fail "container exited"
  sleep 1
done
[ "$status" = healthy ] || fail "healthcheck status: $status"

# Numeric uid:gid, so Kubernetes' runAsNonRoot can verify it without resolving a user name.
[ "$(docker inspect -f '{{.Config.User}}' "$name")" = 1000:1000 ] || fail "image user is not the numeric 1000:1000"
[ "$(docker exec "$name" id -u):$(docker exec "$name" id -g)" = 1000:1000 ] || fail "process does not run as 1000:1000"
# AGPL-3.0 text and the third-party notices ship in the image.
docker exec "$name" grep -q 'GNU AFFERO GENERAL PUBLIC LICENSE' /app/LICENSE || fail "/app/LICENSE missing"
docker exec "$name" grep -q '^klinecharts ' /app/THIRD_PARTY_NOTICES.txt \
  || fail "/app/THIRD_PARTY_NOTICES.txt missing or incomplete"
echo "platform: $(docker exec "$name" node -p 'process.platform + "/" + process.arch')"

hostport="$(docker port "$name" 8787/tcp | head -n 1)"
base="http://${hostport}"

body="$(fetch "$base/api/health")" || fail "/api/health"
grep -q '"ok":true' <<<"$body" || fail "/api/health: $body"
body="$(fetch "$base/")" || fail "web UI index"
grep -qi '<div id="root"' <<<"$body" || fail "web UI index has no app root"
body="$(fetch "$base/api/bars?symbol=stock:AAPL&tf=1D&session=rth&from=1704067200000&to=1735689600000")" \
  || fail "/api/bars"
grep -q '"bars":\[{' <<<"$body" || fail "/api/bars returned no bars"
fetch -X PUT -H 'content-type: application/json' --data '[]' "$base/api/watchlist" >/dev/null \
  || fail "write to the database on /data"

# SQLite spills large sorts and VACUUM to temp files (TMPDIR); with a read-only root filesystem they must land
# on the writable /tmp, else queries fail with SQLITE_IOERR_GETTEMPPATH.
docker exec "$name" node -e "
  const Database = require('better-sqlite3');
  const db = new Database('/data/smoke-spill.db');
  db.pragma('cache_size = -64');
  db.exec('CREATE TABLE t (x BLOB)');
  const insert = db.prepare('INSERT INTO t VALUES (randomblob(500))');
  db.transaction(() => { for (let i = 0; i < 20000; i++) insert.run(); })();
  if (db.prepare('SELECT x FROM t ORDER BY x').all().length !== 20000) throw new Error('sort');
  db.exec('VACUUM');
  db.close();
  require('fs').rmSync('/data/smoke-spill.db');
" || fail "SQLite temp-file spill (large sort / VACUUM)"

echo "stopping (SIGTERM)..."
start=$(date +%s)
docker stop -t 20 "$name" >/dev/null
elapsed=$(( $(date +%s) - start ))
code="$(docker inspect -f '{{.State.ExitCode}}' "$name")"
[ "$code" = 0 ] || fail "exit code after docker stop: $code"
[ "$elapsed" -lt 10 ] || fail "shutdown took ${elapsed}s"
logs="$(docker logs "$name" 2>&1)"
grep -q 'SIGTERM received' <<<"$logs" || fail "no graceful shutdown in the logs"

echo "OK: $image is healthy, serves the API and the web UI, writes only /data and /tmp, and stops cleanly (${elapsed}s)"
