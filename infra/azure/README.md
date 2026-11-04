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
| nginx cache on `/api/public` | Front Door Standard: cached public routes, one WAF rate rule on the subscription form (`edge.tf`) | The archive and the Atom feed are read by crowds after a big announcement; the origin and the database see one request per cache lifetime |
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
- `terraform test` with mocked providers: 24 runs that assert the security and resilience properties the design depends on (database private, Entra-only, zone-redundant, locked; registry and vault without stored credentials; two replicas minimum; `AUTH_MODE=oidc`, `DEMO=0`; only the application subnet reaches the database; PKCE-only browser app; one assignment per mapped group; each consumer set is its own app with no ingress, no scale-to-zero and no plain-text secret; a new agent is one map entry and changes nothing else; mail goes through the managed identity with no SMTP password; only public reads are cached and the WAF blocks; with Front Door or mail switched off the right resources and settings disappear; bad input is refused). A deliberate change to one of those properties makes a test fail (checked). Validation against the real provider schema also caught an invalid Front Door compression type before any deploy.
- `tflint` (azurerm ruleset), `trivy config` (no findings; one intended internet-facing rule is annotated) and `checkov` (21 passed, 9 skipped, each skip carries its reason in the code: Premium-only registry features, a private endpoint where a firewall or VNet integration already does the job).
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

## Before the first apply

1. **State storage.** Create a storage account for state (outside this configuration), with blob versioning and soft delete, public access off, and give the people and pipeline that run Terraform *Storage Blob Data Contributor*. `backend.tf` signs in with Entra, no key.
2. **Resource providers.** A subscription owner registers once: `Microsoft.App`, `Microsoft.ContainerRegistry`, `Microsoft.DBforPostgreSQL`, `Microsoft.KeyVault`, `Microsoft.ManagedIdentity`, `Microsoft.Network`, `Microsoft.OperationalInsights`, `Microsoft.Insights`, `Microsoft.Consumption`. The configuration does not register them (`resource_provider_registrations = "none"`).
3. **Who runs Terraform.** On the subscription or resource group: *Contributor* and *User Access Administrator* (it creates role assignments). In Entra: *Application Administrator* (it creates the two app registrations and, if used, group-to-role assignments). Use a person for the first apply and a pipeline identity afterwards.
4. **An Entra group for database administration** (`dba_group_object_id`). Password sign-in is disabled, so without it nobody can create database roles.
5. **Quota and region.** The region must have availability zones. Check Container Apps and `GP_Standard_D2ds_v5` quota in it.
6. Copy `terraform.tfvars.example` to `<environment>.tfvars` and fill it in.
7. **The reader token key.** After stage 1 below, put 32 or more random characters in the vault as `reader-token-key` (the name is `reader_token_secret_name`), the same way as the provider key: from the Azure CLI, with a temporary firewall rule for your address, removed afterwards. Rotating it makes unsubscribe links already sent stop working, so rotate deliberately.
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
# 3. push a first image (the deploy workflow does it; or docker push to registry_login_server)
# 4. the rest
terraform apply -var-file=prod.tfvars
# 5. migrate, then roll out: run the azure-deploy workflow, then re-run the REVOKE at the bottom of bootstrap-roles.sql
```

Use `terraform output` for the values the workflow needs (`registry_login_server`, `migrate_job`, `deploy_identity_client_id`, `tenant_id`, `resource_group`).
The `api_image` variable defaults to a placeholder image so the first apply succeeds; after that the pipeline owns the image and Terraform ignores changes to it.

## Not included, and when to add it

| Missing | Add it when |
|---|---|
| WAF managed rules, a custom domain on Front Door, a customer mail domain | Front Door is on (Standard: custom rules only, no managed rule sets, default `*.azurefd.net` address). Premium (managed rules, private origin) costs several times more; a custom domain and mail domain need DNS records the platform team owns. |
| Service Bus for the event outbox | Events leave the single database: a consumer outside this system, or more than a few hundred events a second. Consumers are behind a port, so the swap is an adapter plus an outbox relay, not a rewrite. |
| Private endpoints for the registry and the vault | Security policy forbids their public endpoints. Needs ACR Premium and self-hosted pipeline runners. Today: registry has no anonymous or admin access, vault firewall admits only the application subnet. |
| Egress firewall | Policy requires an allow-list of outbound destinations. The container subnet's outbound is unrestricted; the database subnet accepts only the application subnet. |
| A second region | An RTO shorter than "restore from geo-redundant backup in the paired region" (hours) is required. The queue is the database, so a warm standby is a read replica plus a second container environment. |
| Tracing / Application Insights | A real gateway adds latency worth attributing. Logs, `/metrics` and the failure alert cover the current needs. |
| Landing zone, Policy, Defender for Cloud | These belong to the subscription, not to this workload; the tag rules (`owner`, `cost_centre`) and locks follow the CAF landing-zone conventions. |
| Narrower deployment identity | Replace *Contributor on the resource group* with a custom role limited to updating the three container resources and pushing to the registry. |
