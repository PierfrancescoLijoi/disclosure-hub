#!/usr/bin/env bash
# What can only be proven against a running deployment, as commands with a pass or fail each: items 11, 12, 13
# and 15 of the README's unproven list, plus the private-ingress path. Run it after the first apply and after
# every rollout (the deploy workflow does).
#
#   bash smoke.sh <edge-url> [direct-origin-url]
#
#   edge-url           the Front Door address (terraform output app_url)
#   direct-origin-url  the container app's own address (az containerapp show ... ingress.fqdn): proves the direct
#                      path is closed. With private_ingress it is not reachable at all, which also passes.
#
# Optional, from the environment:
#   LOG_WORKSPACE_ID  Log Analytics workspace id (customer id). Needs `az login`. Enables the two checks that
#                     read the application's own log: the client address the app sees (X-Forwarded-For hops) and
#                     whether any request arrived without the edge id (safe to set edge_id_mode = enforce).
#
# Exit code is the number of failed checks. Warnings (not failures) are things that may just need more time.
set -uo pipefail

EDGE="${1:?usage: smoke.sh <edge-url> [direct-origin-url]}"
EDGE="${EDGE%/}"
DIRECT="${2:-}"
DIRECT="${DIRECT%/}"
FAILS=0
WARNS=0

pass() { echo "  ok    $1"; }
fail() { echo "  FAIL  $1"; FAILS=$((FAILS + 1)); }
warn() { echo "  warn  $1"; WARNS=$((WARNS + 1)); }
status() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
header() { curl -s -D - -o /dev/null --max-time 20 "$2" | tr -d '\r' | grep -i "^$1:" | head -1 | cut -d: -f2- | sed 's/^ *//'; }

echo "== edge: the app answers through Front Door"
for i in $(seq 1 30); do
  code=$(status "$EDGE/readyz")
  [ "$code" = 200 ] && break
  sleep 10
done
if [ "$code" = 200 ]; then pass "$EDGE/readyz -> 200"; else
  fail "$EDGE/readyz -> $code (502/504 right after the first apply means the Private Link connection is not approved yet: bash scripts/approve-private-link.sh)"
fi

echo "== item 12: caching of public reads"
URL="$EDGE/api/public/options"
cc=$(header cache-control "$URL")
case "$cc" in *max-age=30*) pass "cache-control on public reads: $cc" ;; *) fail "cache-control on public reads is '$cc', expected max-age=30" ;; esac
status "$URL" >/dev/null
xc=$(header x-cache "$URL")
case "$xc" in *HIT*) pass "second read is served by the edge (x-cache: $xc)" ;; *) warn "second read was not an edge hit (x-cache: '${xc:-absent}'); Front Door may need a minute to populate, rerun" ;; esac
code=$(status -X POST -H 'content-type: application/json' -d '{}' "$EDGE/api/public/subscriptions")
case "$code" in 400|422|429) pass "the subscription form reaches the API and is validated (POST -> $code)" ;; *) fail "POST /api/public/subscriptions -> $code, expected the API's own 4xx" ;; esac
xc=$(curl -s -D - -o /dev/null -X POST -H 'content-type: application/json' -d '{}' "$EDGE/api/public/subscriptions" | tr -d '\r' | grep -i '^x-cache:' | head -1)
case "$xc" in *HIT*) fail "a POST was served from cache: $xc" ;; *) pass "a POST is never cached" ;; esac

echo "== item 15 and private ingress: the direct path is closed"
if [ -z "$DIRECT" ]; then
  warn "no direct origin address given: not checked"
else
  code=$(status "$DIRECT/api/public/options")
  case "$code" in
    000) pass "direct address unreachable (private ingress)" ;;
    403) pass "direct address answers 403 (edge id enforced)" ;;
    200) fail "direct address answers 200: the WAF rate rule and the cache can be skipped (private_ingress off and edge_id_mode = log?)" ;;
    *) warn "direct address -> $code" ;;
  esac
fi

echo "== item 11 and 15 from the application log (needs LOG_WORKSPACE_ID)"
if [ -z "${LOG_WORKSPACE_ID:-}" ] || ! command -v az >/dev/null; then
  warn "LOG_WORKSPACE_ID or az missing: skipped (client address seen by the app, requests without the edge id)"
else
  ID="smoke$(date +%s)$RANDOM"
  MYIP=$(curl -s --max-time 10 https://api.ipify.org || true)
  status "$EDGE/api/public/$ID" >/dev/null # a path nothing serves: the request is logged with the address the app trusted
  echo "  waiting for the log (ingestion takes 2-5 minutes)..."
  seen=""
  for i in $(seq 1 30); do
    seen=$(az monitor log-analytics query -w "$LOG_WORKSPACE_ID" --analytics-query "ContainerAppConsoleLogs_CL | where Log_s has '$ID' | extend j=parse_json(Log_s) | where isnotempty(j.req.remoteAddress) | project a=tostring(j.req.remoteAddress) | take 1" --query "[0].a" -o tsv 2>/dev/null || true)
    [ -n "$seen" ] && break
    sleep 20
  done
  if [ -z "$seen" ]; then warn "the request never showed up in the log: check ContainerAppConsoleLogs_CL and the workspace id"
  elif [ -n "$MYIP" ] && [ "$seen" = "$MYIP" ]; then pass "the app sees the client address ($seen): TRUST_PROXY hop count is right"
  else fail "the app sees $seen but this machine is $MYIP: adjust TRUST_PROXY in apps.tf (too low shows an Azure address, too high lets a client forge its own)"; fi

  missing=$(az monitor log-analytics query -w "$LOG_WORKSPACE_ID" --analytics-query "ContainerAppConsoleLogs_CL | where TimeGenerated > ago(1h) | where Log_s has 'request without the edge id' | where Log_s !has '/healthz' | summarize count()" --query "[0].count_" -o tsv 2>/dev/null || echo "")
  if [ -z "$missing" ]; then warn "could not read the edge-id log"
  elif [ "$missing" = 0 ]; then pass "no request in the last hour arrived without the edge id: edge_id_mode = enforce is safe (after real traffic has passed through)"
  else fail "$missing request(s) in the last hour arrived without the right X-Azure-FDID: keep edge_id_mode = log and find out why"; fi
fi

echo
echo "$FAILS failed, $WARNS warning(s)"
exit "$FAILS"
