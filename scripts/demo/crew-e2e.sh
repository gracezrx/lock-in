#!/usr/bin/env bash
# Two copies of Lock In in one crew, over a relay on this machine: make a crew, join it with the
# code, see each other's minutes, try to bomb someone locked in (refused), bomb them once they
# stop (their distractions lock). Screenshots and results land in $OUT.
#   bash scripts/demo/crew-e2e.sh [out-dir]          (Linux: needs xvfb-run)
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-release/crew-e2e}"
rm -rf "$OUT" && mkdir -p "$OUT/host" "$OUT/guest" "$OUT/shots"
PORT=$((20000 + RANDOM % 20000))
node scripts/demo/crew-relay.mjs "$PORT" >"$OUT/relay.log" 2>&1 &
RELAY=$!
trap 'kill $RELAY 2>/dev/null || true' EXIT
sleep 1
run() {
  HOME="$OUT/$1" XDG_CONFIG_HOME="$OUT/$1/.config" LOCKIN_SMOKE=1 LOCKIN_SHOTS="$OUT/shots" LOCKIN_RELAY="http://127.0.0.1:$PORT" \
    LOCKIN_CREW_E2E="$1" LOCKIN_E2E_DIR="$OUT" xvfb-run -a -s "-screen 0 1440x1000x24" npx electron . --no-sandbox 2>&1 | grep --line-buffered -E "^E2E|SMOKE|Error" >"$OUT/$1.log"
}
run host &
HOST=$!
sleep 4
run guest &
GUEST=$!
wait $HOST && wait $GUEST
echo "host:"; cat "$OUT/host.log"; echo "guest:"; cat "$OUT/guest.log"
grep -q "TOO BIG" "$OUT/relay.log" && { echo "A message was too big for the relay"; exit 1; } || true
cat "$OUT/host-result.json" "$OUT/guest-result.json"
