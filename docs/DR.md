# Disaster recovery: losing the primary region

Scope: the Azure deployment in `infra/azure` with `dr_location` set. A zone failure is not this document: the
database has a synchronous standby in another zone and the apps are zone-redundant, so a zone loss is a short failover
that nobody triggers. This is for losing the whole region.

**Status: designed, validated offline (`terraform validate`, mocked-provider tests), never applied and never
rehearsed.** The times below are design figures. The first rehearsal in `test` replaces them with measurements
(table at the end).

## What exists while the primary region is healthy

| | Primary region | Second region (`dr_location`) |
|---|---|---|
| Database | PostgreSQL, zone-redundant HA, Entra only | **Read replica**, asynchronous, private, no HA while it is a replica |
| Container apps | api (2-4), worker (2-3), event consumers (1-2 each) | api at 1 replica; worker and consumers **at 0** |
| Images | Registry (Premium) | Geo-replica of the same registry, reached through its own private endpoint |
| Secrets | Key Vault | Same vault, through a private endpoint in the second region's network |
| Edge | Front Door, origin priority 1 | Same Front Door, origin priority 2: used only when priority 1 fails its health probe |
| Network | VNet, NAT gateway | VNet, NAT gateway, global peering with the primary (replication runs over it) |

The standby API answers reads (archive, feed, search) from the replica, so readers keep seeing announcements while a
person decides. Writes fail until the replica is promoted: publishing, drafts and the subscription form need the
primary database. Writers and consumers are at zero on purpose: nothing may write events while the database is
read-only, and a consumer running against a replica would only fail.

## Numbers

- **RPO** = the replica lag at the moment of loss. It is asynchronous replication, usually seconds, alerted at five
  minutes (`postgres-dr-replica-lag`). A forced promotion loses whatever the replica had not received.
- **RTO** = the time to decide + promotion + starting the writers. Design figure: about 15 minutes after the decision
  (promotion of a replica is minutes; scaling container apps from zero is a minute or two). Not measured.
- Not automatic, by design. A false positive from a probe blip would promote the replica while the primary still
  accepts writes, and two writers cannot be merged. Front Door does move **reads** to the second region by itself.

## Declaring a regional failover

Who decides: the on-call lead for the platform, with the company secretary (it is their publication window that
stops). Evidence to have: the Azure status page for the region, the `afd` origin health in the portal, the replica lag.

```bash
# 1. look first (changes nothing)
bash infra/azure/scripts/dr-failover.sh dhub-prod

# 2a. the primary region is gone: promote now, accept the loss of un-replicated writes
DBA_GROUP_OBJECT_ID=<guid> bash infra/azure/scripts/dr-failover.sh dhub-prod --execute --forced

# 2b. a rehearsal or planned move, primary still healthy: waits for the replica to catch up, loses nothing
DBA_GROUP_OBJECT_ID=<guid> bash infra/azure/scripts/dr-failover.sh dhub-prod --execute --planned --drain-primary

# 3. prove it works through the edge, including a write
bash infra/azure/scripts/smoke.sh https://<front-door-address>
```

The script promotes the replica to a stand-alone server, re-adds the database administrator, then raises the second
region's apps to the primary's floor. After it, publish a test announcement in a test company, and tell the issuers'
secretaries which announcements in the last minutes before the loss to check (the audit log of the promoted copy
shows the last one it holds).

## After a failover

The second region **is** the platform now and Terraform no longer matches: the replica is a stand-alone server and the
apps were scaled by hand. Do not run `terraform apply` against the old state.

1. Turn high availability on for the promoted server: `az postgres flexible-server update ... --high-availability ZoneRedundant`.
2. When the old region returns, do not switch it back on. Rebuild it as a replica of the promoted server (new server in
   the old region with `create_mode = Replica`), let it catch up, and decide separately, with a planned `--planned`
   promotion back, whether to return.
3. Reconcile Terraform: import the promoted server as the primary, set `location`/`dr_location` to the new roles, run
   `terraform plan` until it shows no destructive change. This is the least rehearsed step: do it in `test` first.

## Rehearsal

Rehearse in `test` before relying on this, and again after any change to the network or the database SKU: a
`--planned --drain-primary` run, then the steps under "After a failover". Record the times here.

| Date | Environment | Decision to writes accepted | Replica lag at start | What did not work |
|---|---|---|---|---|
| _not yet run_ | | | | |

## What is not covered

- Loss of the **Entra tenant** or of the Front Door global control plane: no regional design helps.
- Data written to the primary and not replicated when the region is lost (the RPO), under `--forced`.
- Region pair and residency: `northeurope` leaves the UK. Check the contract with each issuer before choosing it; the
  allowed-locations policy in `infra/azure-landing-zone` must list the second region.
- Some things live in the primary region: the managed identity, the Key Vault (read-only copy in its paired region is Microsoft's own behaviour, not this design's), the Log Analytics workspace, the Front Door profile's resource group, and the migrate job. If the control plane for that region is unreachable, the failover script's edge step and the second region's secret reads may fail; the script lists what failed instead of hiding it. Migrations cannot run after a failover until the primary resources are rebuilt or moved. Moving the identity and the vault to a region-independent footing is the next hardening step and is not done.
- The ACR Tasks agent pool exists in the primary region only: new images cannot be built while it is down. The images
  already built are in the geo-replica, so a rollback and a restart work; a new release waits (or builds elsewhere).
