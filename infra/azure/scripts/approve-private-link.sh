#!/usr/bin/env bash
# Approves the Private Link connection Front Door opens to each Container Apps environment (private_ingress).
# Terraform can create the request but not approve it: approval is the owner of the environment saying yes, so it
# stays a person's step, once per environment (the primary and, when dr_location is set, the second region).
#
#   bash approve-private-link.sh <resource-group> [<resource-group> ...]
#
# Lists first, approves only Pending connections whose request message is Front Door's, and prints what it approved. Needs `az login` as someone
# with rights on the environment. The REST api-version can be overridden with PRIVATE_LINK_API_VERSION.
set -euo pipefail

API="${PRIVATE_LINK_API_VERSION:-2024-03-01}"
[ "$#" -ge 1 ] || { echo "usage: approve-private-link.sh <resource-group> [...]"; exit 2; }

approved=0
for RG in "$@"; do
  for ENV_ID in $(az containerapp env list -g "$RG" --query "[].id" -o tsv); do
    echo "environment: $ENV_ID"
    LIST=$(az rest --method get --url "https://management.azure.com${ENV_ID}/privateEndpointConnections?api-version=${API}" --query "value[].{id:id,state:properties.privateLinkServiceConnectionState.status,from:properties.privateEndpoint.id,msg:properties.privateLinkServiceConnectionState.description}" -o json)
    echo "$LIST" | python3 -c 'import json,sys
for c in json.load(sys.stdin): print("  ", c["state"], c["id"].rsplit("/",1)[-1], "<-", (c.get("from") or "").rsplit("/",1)[-1])' || true
    for CONN in $(echo "$LIST" | python3 -c 'import json,sys
for c in json.load(sys.stdin):
    # Only the request Terraform made (edge.tf request_message starts with "Front Door"): any other request stays pending.
    if c["state"] == "Pending" and (c.get("msg") or "").startswith("Front Door"): print(c["id"])'); do
      az rest --method put --url "https://management.azure.com${CONN}?api-version=${API}" \
        --body '{"properties":{"privateLinkServiceConnectionState":{"status":"Approved","description":"Approved for Front Door"}}}' >/dev/null
      echo "  approved $(basename "$CONN")"
      approved=$((approved + 1))
    done
  done
done
echo "$approved connection(s) approved. Front Door needs a few minutes to use them; then run scripts/smoke.sh."
