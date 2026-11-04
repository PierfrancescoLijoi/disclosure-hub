# Disclosure Hub on Azure

The same application as `docker-compose.yml`, on managed services. The container image, the API, the rules and the
state machine are identical; environment variables choose the adapters.

| Local (`docker compose up`) | Azure (this directory) | Why this choice |
|---|---|---|
| `postgres` container | PostgreSQL Flexible Server 16, zone-redundant HA, private, Entra-only | One system of record; a standby in another zone with synchronous replication, no password anywhere |
| `keycloak` (OIDC) | Microsoft Entra ID: API + browser app registrations, five app roles | Real sign-in, MFA and Conditional Access are the company's existing Entra policy |
| `api`, `worker` | Container Apps `api` and `worker`, two replicas minimum, zone-redundant environment | No cluster to run; scale on the real signal; the worker has no ingress |
| `notifier`, `agents` (`ROLE=events`) | One Container App per entry of `consumer_sets` (`events.tf`), no ingress, one replica minimum | The extension seam: each consumer set drains the shared event outbox on its own, so a slow mail service or a costly model cannot slow publishing or each other. A new agent is one more map entry |
| `mailpit` (SMTP sink) | Azure Communication Services Email, Azure-managed sender domain, sent with the app's managed identity (`readers.tf`) | No SMTP password or connection string exists; the same code sends through SMTP locally and through the Email REST API here |
| nginx cache on `/api/public` | Front Door **Premium**: cached public routes, managed WAF rule sets (default rules 2.1, bot manager 1.1; Log first) and a rate rule on the subscription form, Private Link to the environment (`edge.tf`) | The archive and the Atom feed are read by crowds after a big announcement; the origin and the database see one request per cache lifetime. Premium is what managed rules and a private origin need |
| (not applicable) | Private network (`network.tf`, `registry.tf`, `keyvault.tf`): the environment has no public address, registry (Premium) and vault have private endpoints and no public access, builds run in a registry agent pool, outbound leaves through one NAT gateway | Nothing reaches the apps except through the edge; the registry and the vault are not on the internet; one known egress address |
| (not applicable) | Second region (`dr.tf`, off unless `dr_location` is set): database read replica, registry geo-replica, standby API, writers at zero, Front Door fallback origin | A regional loss costs a decision and about 15 minutes (design figure), not a restore from backup. `docs/DR.md` |
| (not applicable) | `infra/azure-landing-zone`: management groups, policy assignments (report first), RBAC by group | Governance belongs to the tenant, not to a workload; a separate root with its own state |
| `READER_TOKEN_KEY` in env (dev only) | Key Vault secret `reader-token-key`, referenced by the api and the consumer sets | Confirmation, unsubscribe and webhook-signing secrets derive from it; created out of band like every secret here |
| `migrate` | Container Apps job `migrate`, started by the pipeline before each rollout | The schema owner is a different identity from the runtime |
| `web` (nginx) | Served by the API container behind the platform ingress (TLS) | One fewer moving part |
| `QUEUE_URL=pg` | Same: `LISTEN/NOTIFY` on the database | No Redis to patch or pay for at this size; BullMQ stays available |
| password in env (dev only) | managed identity token as the database password (`DATABASE_AUTH=azure-managed-identity`) | Nothing to rotate or leak |
| `.env` | Key Vault, referenced by the container app (only the model provider key, if used) | |
| `docker stats`, `/metrics` | Log Analytics, 8 alerts, a budget, plus a replica alert per consumer set, outbox lag and dead deliveries (the consumers log the same numbers as `/metrics` every minute) | |

Sizing and the reasons behind it: [`docs/SIZING.md`](../../docs/SIZING.md). Architecture: [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

## What is verified, and what is not

**Verified here, without an Azure subscription** (`bash scripts/verify.sh`, needs Docker; also runs in CI):

- `terraform fmt`, `init`, `validate` against the real provider schemas (azurerm 4.81, azuread 3.10): every argument exists and has a valid value.
- `terraform test` with mocked providers: 41 runs here (7 more for the landing zone) that assert the security and resilience properties the design depends on (private registry, vault and environment; Premium edge with managed rules in Log mode and a private origin; the cheap development configuration; the second region as a replica with writers at zero and a lower-priority Front Door origin; a read replica that is opt-in and wired to the api only; database private, Entra-only, zone-redundant, locked; registry and vault without stored credentials; two replicas minimum; `AUTH_MODE=oidc`, `DEMO=0`; only the application subnet reaches the database; PKCE-only browser app; one assignment per mapped group; each consumer set is its own app with no ingress, no scale-to-zero and no plain-text secret; a new agent is one map entry and changes nothing else; mail goes through the managed identity with no SMTP password; only public reads are cached and the WAF blocks; with Front Door or mail switched off the right resources and settings disappear; bad input is refused). A deliberate change to one of those properties makes a test fail (checked). Validation against the real provider schema also caught an invalid Front Door compression type before any deploy.
- `tflint` (azurerm ruleset), `trivy config` (no findings; the one internet-facing rule exists only when `private_ingress` is off) and `checkov` (each skip carries its reason in the code). The landing zone has its own `scripts/verify.sh` with the same checks.
- The application side of the same contract, run locally: OIDC verification against a JWKS (unit tests and real Keycloak), the PostgreSQL queue including a listener reconnect, the migrate/api/worker split, and the load profile in `docs/SIZING.md`.

**Not verified: nothing here was applied.** No subscription was used. These are the things that can only be proven on the
first deploy; each has an owner step below.

| # | Unproven | How the first deploy proves it |
|---|---|---|
| 1 | Entra puts app roles in the access token (`roles`) and the browser app obtains a token for `api://<id>/access_as_user` | Sign in as a user in each role group; decode the token; call `/api/me` |
| 2 | The server's token-as-password connection works against Flexible Server, and a connection recycled at 30 minutes gets a fresh token | `bootstrap-roles.sql`, start `migrate`, watch the app stay connected past an hour |
| 3 | `LISTEN/NOTIFY` works on port 5432 (direct, not the built-in PgBouncer on 6432, which would break it) | Publish an announcement; the worker acts within a second, not at the next sweep |
| 4 | Container Apps accepts the subnet, the NSG (443 in) and the zone-redundant environment in the chosen region | `terraform apply` stage 4 |
| 5 | The alert metrics and the log query use the right names (`Replicas`, `RestartCount`, `Requests` by `statusCodeCategory`; `ContainerAppConsoleLogs_CL`, `Log_s`) | Scale a replica to zero in a test environment, force a failing publication, confirm the e-mails |
| 6 | The deploy workflow (`.github/workflows/azure-deploy.yml`) and its federated sign-in | Run it for `test` |
| 7 | Failover and restore: forced database failover, point-in-time restore, geo-restore into the paired region | A written drill in `test`, with the measured times recorded in `docs/SIZING.md` |
| 8 | Group-to-role assignment (needs Entra ID P1; without it assign roles per user in the portal) | Plan shows the assignments; if the licence is missing, leave `role_groups` empty |
| 9 | The Email REST API accepts a token for the managed identity (scope `https://communication.azure.com/.default`) and the endpoint is `https://<resource>.communication.azure.com` (read from the portal if it differs, then set it in `readers.tf`); the role *Communication and Email Service Owner* is the documented one and broader than sending | Follow a test address, confirm, publish; the message arrives. A custom role limited to send is the tightening |
| 10 | The Azure-managed sender domain is accepted and its volume limit is enough for the first readers | Same test; a customer domain (DNS records owned by the platform team) is the next step before real volume |
| 11 | `TRUST_PROXY` hop counts (2 behind Front Door, 1 without) match what `X-Forwarded-For` carries, so the per-client rate limit sees the reader and not the edge | Post the subscription form from two networks and check the 429 counters are separate; adjust the two numbers in `apps.tf` |
| 12 | Front Door honours the `Cache-Control` the API sends (30 s public reads, 60 s feed), keeps one entry per query string, and never caches the POSTs | `curl -I` the archive twice and read `x-cache`; post the form and check it reaches the API |
| 13 | A Key Vault reference works for `reader-token-key` in the api and in every consumer set | Create the secret (below), apply; a container app that cannot read it fails to start, which is loud |
| 14 | Outbox lag and dead-delivery alerts fire (log fields `oldestPendingSeconds`, `dead`) | Stop a consumer set for 10 minutes while publishing; revoke the mail role for a few retries and watch the dead alert |
| 15 | The api answers only requests that carry the Front Door id (`EDGE_ID` = the profile's `resource_guid`, compared with `X-Azure-FDID`, which Front Door adds to every origin request); probes are exempt. Direct calls to the container app address get 403, so the WAF rule and cache cannot be skipped | `curl` the container app address directly (expect 403) and through the edge (expect 200); if Front Door does not send the header as documented, the whole site answers 403: unset `EDGE_ID` on the api to recover. The web app origin is not restricted (static files, no data) |
| 16 | Front Door reaches the Container Apps environment over Private Link: the connection appears as Pending and is approved by `scripts/approve-private-link.sh` (the REST api-version may differ: `PRIVATE_LINK_API_VERSION`); the environment accepts it with `public_network_access = "Disabled"` | After the apply: run the script, wait a few minutes, `smoke.sh <edge> <direct address>`: 200 through the edge, unreachable directly. 502 from the edge means the connection is not approved |
| 17 | `X-Azure-FDID` equals the profile's `resource_guid` and arrives as documented. `EDGE_ID_MODE` starts at `log`: nothing is refused, mismatches are logged | `smoke.sh` with `LOG_WORKSPACE_ID`: zero requests without the id after real traffic, then set `edge_id_mode = "enforce"`. Even before that, the network blocks the direct path (item 16) |
| 18 | A NAT gateway on the Container Apps subnet gives the workload-profile environment its outbound address, including to the registry's and the vault's private endpoints (which do not use it) | Read `egress_ip` and call a test URL from a container; pull an image; read a secret |
| 19 | The registry agent pool builds from `az acr build --agent-pool` while the registry has no public endpoint, and the run's digest is readable from the management plane (`az acr task show-run`) | Run the deploy workflow for `test`; the build and the digest step succeed |
| 20 | Container Apps resolves Key Vault references through the vault's private endpoint and the linked private DNS zone | The apps start (a failed reference fails the start) |
| 21 | The WAF's managed rules do not block legitimate traffic: Log first, read `FrontDoorWebApplicationFirewallLog` for a week, add exclusions, then `waf_managed_rules_action = "Block"` | See "Turning the WAF to Block" |
| 22 | The second region: the replica is created over the peered networks, the application identity can sign in to the replica (Entra administrators and roles carry over; if not, `dr-failover.sh` re-adds the administrator), promotion works, the standby API passes its probe against a read-only database, writers start from zero | A rehearsal in `test` (`docs/DR.md`), times recorded there |
| 23 | The landing zone: built-in policy definitions are found by display name at plan time (a wrong name fails the plan), management group association works for the chosen subscriptions | `terraform plan` in `infra/azure-landing-zone`; policies stay in report-only mode until compliance has been read |
| 24 | Sizing on Azure: what the edge and the origin serve to a crowd, database CPU under it | `infra/azure/loadtest/public-read.mjs`, `docs/SIZING.md` table |

## Before the first apply

1. **State storage.** Create a storage account for state (outside this configuration), with blob versioning and soft delete, public access off, and give the people and pipeline that run Terraform *Storage Blob Data Contributor*. `backend.tf` signs in with Entra, no key.
2. **Resource providers.** A subscription owner registers once: `Microsoft.App`, `Microsoft.ContainerRegistry`, `Microsoft.DBforPostgreSQL`, `Microsoft.KeyVault`, `Microsoft.ManagedIdentity`, `Microsoft.Network`, `Microsoft.OperationalInsights`, `Microsoft.Insights`, `Microsoft.Consumption`. The configuration does not register them (`resource_provider_registrations = "none"`).
3. **Who runs Terraform.** On the subscription or resource group: *Contributor* and *User Access Administrator* (it creates role assignments). In Entra: *Application Administrator* (it creates the two app registrations and, if used, group-to-role assignments). Use a person for the first apply and a pipeline identity afterwards.
4. **An Entra group for database administration** (`dba_group_object_id`). Password sign-in is disabled, so without it nobody can create database roles.
5. **Quota and region.** The region must have availability zones. Check Container Apps and `GP_Standard_D2ds_v5` quota in it.
6. Copy `terraform.tfvars.example` to `<environment>.tfvars` and fill it in.
7. **The reader token key.** After stage 1 below, put 32 or more random characters in the vault as `reader-token-key` (the name is `reader_token_secret_name`), the same way as the provider key. The apps cannot be created without that secret (a Key Vault reference is read at creation), and the vault is closed to the internet (`private_data_plane`): set `key_vault_allowed_ips` to your address in the first apply (stage 1), add the secret from that address, apply stage 4, then empty the list and apply again. Under an enforced landing-zone policy for vault public access, add an exemption for that hour. Rotating it makes unsubscribe links already sent stop working, so rotate deliberately.
8. Register `Microsoft.Communication` and `Microsoft.Cdn` as well when using reader email and Front Door.

## Apply in stages

The application containers start failing if the database roles do not exist yet, so apply in this order and stop to check:

```bash
cd infra/azure
terraform init -backend-config=... # see backend.tf
terraform plan -var-file=prod.tfvars -out=prod.plan        # read it
# 1. everything the application does not run on yet
terraform apply -var-file=prod.tfvars \
  -target=azurerm_container_registry.main -target=azurerm_key_vault.main \
  -target=azurerm_postgresql_flexible_server_database.hub -target=azurerm_postgresql_flexible_server_active_directory_administrator.dba \
  -target=azurerm_user_assigned_identity.app -target=azurerm_user_assigned_identity.migrate
# 2. database roles: run scripts/bootstrap-roles.sql (see its header) from inside the network
# 3. nothing to push yet: the apps start on a placeholder image (api_image); the first real image is built by the workflow in step 5
# 4. the rest
terraform apply -var-file=prod.tfvars
#    then approve the Private Link connection(s) Front Door opened (once per region):
bash scripts/approve-private-link.sh "$(terraform output -raw resource_group)"   # add $(terraform output -raw resource_group_dr) with dr_location
# 5. migrate, then roll out: run the azure-deploy workflow (it builds in the agent pool, migrates, rolls out, smoke-tests through the edge),
#    then re-run the REVOKE at the bottom of bootstrap-roles.sql
```

Use `terraform output` for the values the workflow needs (`registry_login_server`, `build_agent_pool`, `migrate_job`, `deploy_identity_client_id`, `tenant_id`, `resource_group`, `resource_group_dr`, `app_url`).

### Turning the edge id and the WAF from watching to enforcing

Both start in a mode that cannot lock people out, because neither has been seen working on Azure:

1. `edge_id_mode = "log"` (default). After real traffic has passed through Front Door, `LOG_WORKSPACE_ID=$(terraform output -raw log_workspace_id) bash scripts/smoke.sh <app_url>` reports whether any request arrived without the right `X-Azure-FDID`. Zero: set `edge_id_mode = "enforce"` and apply.
2. `waf_managed_rules_action = "Log"` (default). Read the WAF log for a week of normal use, including staff signing in and posting announcements:
   `AzureDiagnostics`-style queries on `FrontDoorWebApplicationFirewallLog` (category enabled in `edge.tf`). Add exclusions for what legitimate traffic trips, then set `"Block"` and apply.

The network already refuses the direct path (Private Link), so neither is the only lock.
The `api_image` variable defaults to a placeholder image so the first apply succeeds; after that the pipeline owns the image and Terraform ignores changes to it.

## What it costs

No price is quoted here (they change and differ by agreement); `docs/SIZING.md` section 6 lists the drivers and the
pricing calculator turns them into a figure. What the private and resilient setup adds over the earlier one:

- **Front Door Premium** has a monthly base fee that is several times Standard's. It is the largest new line.
- **Container Registry Premium** (flat daily rate) and the **build agent pool**, which bills while it exists whether or
  not anything is building.
- **NAT gateway** (hourly plus data) and **private endpoints** (hourly plus data each: registry and vault, and again in
  the second region).
- **A second region** (`dr_location`): a database replica of the primary's size, an API replica, a NAT gateway and
  private endpoints. Writers sit at zero.

`monthly_budget_eur` defaults to 600: a production environment with the Premium edge will need more, so set it from the
calculator, not from the default. For a development environment set `private_data_plane`, `private_ingress` and
`waf_managed_rules` to `false`: Standard registry and edge, public with identities only, no NAT, no endpoints, no pool.

## Not included, and when to add it

| Missing | Add it when |
|---|---|
| A custom domain on Front Door, a customer mail domain | Both need DNS records the platform team owns. Front Door answers on its default `*.azurefd.net` address until then. |
| Service Bus for the event outbox | Events leave the single database: a consumer outside this system, or more than a few hundred events a second. Consumers are behind a port, so the swap is an adapter plus an outbox relay, not a rewrite. |
| Egress filtering | Policy requires an allow-list of outbound destinations. Outbound leaves through one NAT gateway (one known address) and is not filtered; filtering is Azure Firewall in the hub of a landing zone, with a route table on the container subnet. |
| Automatic regional failover | Never by a probe alone: promoting the replica is irreversible and a false positive means two writers. Reads fail over by themselves; writes by `scripts/dr-failover.sh`, a decision (`docs/DR.md`). |
| Tracing / Application Insights | A real gateway adds latency worth attributing. Logs, `/metrics` and the failure alert cover the current needs. |
| Defender for Cloud plans, a hub network, central logging across subscriptions | Platform subscription concerns; `infra/azure-landing-zone` gives them a place (management groups, policy, RBAC) and leaves the hub and Defender to the platform team. |
| Narrower deployment identity | Replace *Contributor on the resource group* with a custom role limited to updating the three container resources and pushing to the registry. |
