#!/usr/bin/env bash
# Moves the platform to the second region (dr.tf). A decision a person takes, not an automatic reaction: promoting
# the replica cannot be undone, and switching on a probe blip would split the data between two writers.
#
#   bash dr-failover.sh <workload-environment>                      show what it would do (default, changes nothing)
#   bash dr-failover.sh <workload-environment> --execute --forced   the primary region is gone: promote now,
#                                                                   losing whatever the replica had not received
#   bash dr-failover.sh <workload-environment> --execute --planned  rehearsal or planned move: stops the primary's
#                                                                   writers and its traffic first, waits until the
#                                                                   replica has caught up, loses nothing
#
# Both --execute modes make you type the environment name. <workload-environment> is the prefix of the resource
# names, for example dhub-prod. Needs `az login` with rights on both resource groups. Environment overrides:
# DBA_GROUP_OBJECT_ID (re-adds the database administrator on the promoted server), API_MIN (2), WORKER_MIN (2),
# EVENTS_MIN (1).
#
# Every step is counted: the script ends with a list of what failed, and a non-zero exit if anything did. After the
# promotion it does not stop at the first failure, because a half-started second region is worse than a noisy one.
#
# Not measured on Azure (README, first-apply item 22). The first rehearsal in a test environment records the real times
# in docs/DR.md; until then treat "about 15 minutes" as a design figure, not a promise.
set -uo pipefail

NAME="${1:?usage: dr-failover.sh <workload-environment, e.g. dhub-prod> [--execute --forced|--planned]}"
shift
EXECUTE=0; MODE=""
for a in "$@"; do
  case "$a" in
    --execute) EXECUTE=1 ;;
    --forced)
      [ -z "$MODE" ] || { echo "choose --forced or --planned, not both"; exit 2; }
      MODE=forced ;;
    --planned)
      [ -z "$MODE" ] || { echo "choose --forced or --planned, not both"; exit 2; }
      MODE=planned ;;
    *) echo "unknown option $a"; exit 2 ;;
  esac
done
[ "$EXECUTE" = 0 ] || [ -n "$MODE" ] || { echo "--execute needs --forced or --planned"; exit 2; }

PRIMARY_RG="rg-$NAME"
DR_RG="rg-$NAME-dr"
API_MIN="${API_MIN:-2}"; WORKER_MIN="${WORKER_MIN:-2}"; EVENTS_MIN="${EVENTS_MIN:-1}"
FAILED=()

# Runs a command (or only prints it); a failure is recorded and the script goes on.
step() {
  local label="$1"; shift
  if [ "$EXECUTE" = 1 ]; then
    echo "+ $*"
    if ! "$@"; then FAILED+=("$label"); fi
  else
    echo "would run: $*"
  fi
}

# Same, retrying: control-plane calls fail transiently, especially during a regional incident.
retry() {
  local n
  for n in 1 2 3 4 5; do
    "$@" && return 0
    sleep $((n * 5))
  done
  return 1
}

REPLICA=$(retry az postgres flexible-server list -g "$DR_RG" --query "[?contains(name,'-dr')].name | [0]" -o tsv) || true
[ -n "${REPLICA:-}" ] || { echo "no replica found in $DR_RG: is dr_location set and applied?"; exit 1; }

echo "== state before"
az postgres flexible-server show -g "$DR_RG" -n "$REPLICA" --query "{name:name,state:state,role:replicationRole,location:location}" -o table || true
az monitor metrics list --resource "$(az postgres flexible-server show -g "$DR_RG" -n "$REPLICA" --query id -o tsv)" \
  --metric physical_replication_delay_in_seconds --interval PT1M --aggregation Maximum --offset 15M \
  --query "value[0].timeseries[0].data[-1].maximum" -o tsv 2>/dev/null | sed 's/^/replica lag, seconds (last minute): /' || true

if [ "$EXECUTE" = 1 ]; then
  echo
  if [ "$MODE" = forced ]; then
    echo "FORCED promotion: data written to the primary and not yet received by $REPLICA is lost, and cannot be recovered"
    echo "unless the primary region comes back and someone reconciles by hand."
  else
    echo "PLANNED move: the primary's writers and its traffic are stopped, then $REPLICA is promoted. This cannot be undone."
  fi
  read -r -p "Type the environment name ($NAME) to continue: " answer
  [ "$answer" = "$NAME" ] || { echo "cancelled"; exit 1; }
fi

echo
echo "== 0. stop writing in the primary region first (planned move), so there is only ever one writer"
if [ "$MODE" = planned ] || [ "$EXECUTE" = 0 ]; then
  step "stop primary traffic" az afd origin update -g "$PRIMARY_RG" --profile-name "afd-$NAME" --origin-group-name api --origin-name api --enabled-state Disabled -o none
  for APP in $(az containerapp list -g "$PRIMARY_RG" --query "[?!contains(name,'-api')].name" -o tsv 2>/dev/null); do
    step "stop primary writer $APP" az containerapp update -g "$PRIMARY_RG" -n "$APP" --min-replicas 0 --max-replicas 1 -o none
  done
  if [ "$EXECUTE" = 1 ] && [ "${#FAILED[@]}" -gt 0 ]; then
    echo "could not stop the primary region's writers: ${FAILED[*]}"
    echo "Promoting now could leave two writers. Fix this (portal) and run again; nothing has been promoted."
    exit 1
  fi
else
  echo "forced: the primary region is assumed lost; its apps and edge origin cannot be reached or are not trusted."
  step "disable primary origin (best effort)" az afd origin update -g "$PRIMARY_RG" --profile-name "afd-$NAME" --origin-group-name api --origin-name api --enabled-state Disabled -o none
  FAILED=() # best effort only: a lost region is allowed to refuse
fi

echo
echo "== 1. promote the replica to a stand-alone server (point of no return)"
step "promote replica" az postgres flexible-server replica promote -g "$DR_RG" -n "$REPLICA" --promote-mode standalone --promote-option "${MODE:-planned}"

if [ "$EXECUTE" = 1 ]; then
  echo "waiting for the server to be Ready..."
  state=""
  for i in $(seq 1 60); do
    state=$(az postgres flexible-server show -g "$DR_RG" -n "$REPLICA" --query state -o tsv 2>/dev/null || true)
    [ "$state" = Ready ] && break
    sleep 20
  done
  [ "$state" = Ready ] || FAILED+=("server not Ready after 20 minutes (state: ${state:-unknown})")
fi

echo
echo "== 2. the database administrator on the promoted server (an existing one is fine)"
if [ -n "${DBA_GROUP_OBJECT_ID:-}" ]; then
  if [ "$EXECUTE" = 1 ]; then
    out=$(az postgres flexible-server microsoft-entra-admin create -g "$DR_RG" -s "$REPLICA" --display-name dhub-dba --object-id "$DBA_GROUP_OBJECT_ID" --type Group 2>&1) \
      || { echo "$out" | grep -qi "already exist" && echo "already there" || { echo "$out"; FAILED+=("database administrator"); }; }
  else
    echo "would run: az postgres flexible-server microsoft-entra-admin create -g $DR_RG -s $REPLICA ..."
  fi
else
  echo "DBA_GROUP_OBJECT_ID not set: skipped. The application roles came with the data; only the administrator may need re-adding."
fi

echo
echo "== 3. start the writers in the second region (they were at zero while the database was read-only)"
APPS=$(retry az containerapp list -g "$DR_RG" --query "[].name" -o tsv) || { APPS=""; FAILED+=("list the second region's apps"); }
for APP in $APPS; do
  case "$APP" in
    *-api-dr) MIN="$API_MIN" ;;
    *-worker-dr) MIN="$WORKER_MIN" ;;
    *) MIN="$EVENTS_MIN" ;;
  esac
  step "start $APP" retry az containerapp update -g "$DR_RG" -n "$APP" --min-replicas "$MIN" -o none
done

echo
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "== INCOMPLETE: ${#FAILED[@]} step(s) failed"
  printf '  - %s\n' "${FAILED[@]}"
  echo "Do each of these by hand (portal or az) before telling anyone the second region is serving writes."
fi
echo "== next"
echo "- Run: bash infra/azure/scripts/smoke.sh <edge-url>   (reads through the edge), then publish a test announcement."
echo "- Turn high availability on for the promoted server when traffic is stable:"
echo "    az postgres flexible-server update -g $DR_RG -n $REPLICA --high-availability ZoneRedundant"
echo "- When the primary region is back it is rebuilt as a replica of this server; it is never switched back on as it was."
echo "  Terraform then no longer matches reality: follow docs/DR.md, 'After a failover'."
[ "${#FAILED[@]}" -eq 0 ]
