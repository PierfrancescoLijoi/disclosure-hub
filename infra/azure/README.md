# Disclosure Hub on Azure

The same application as `docker-compose.yml`, on managed services. The container image, the API, the rules and the
state machine are identical; environment variables choose the adapters.

| Local (`docker compose up`) | Azure (this directory) | Why this choice |
|---|---|---|
| `postgres` container | PostgreSQL Flexible Server 16, zone-redundant HA, private, Entra-only | One system of record; a standby in another zone with synchronous replication, no password anywhere |
| `keycloak` (OIDC) | Microsoft Entra ID: API + browser app registrations, five app roles | Real sign-in, MFA and Conditional Access are the company's existing Entra policy |
| `api`, `worker` | Container Apps `api` and `worker`, two replicas minimum, zone-redundant environment | No cluster to run; scale on the real signal; the worker has no ingress |
| `migrate` | Container Apps job `migrate`, started by the pipeline before each rollout | The schema owner is a different identity from the runtime |
| `web` (nginx) | Served by the API container behind the platform ingress (TLS) | One fewer moving part |
| `QUEUE_URL=pg` | Same: `LISTEN/NOTIFY` on the database | No Redis to patch or pay for at this size; BullMQ stays available |
| password in env (dev only) | managed identity token as the database password (`DATABASE_AUTH=azure-managed-identity`) | Nothing to rotate or leak |
| `.env` | Key Vault, referenced by the container app (only the model provider key, if used) | |
| `docker stats` | Log Analytics, 8 alerts, a budget | |

Sizing and the reasons behind it: [`docs/SIZING.md`](../../docs/SIZING.md). Architecture: [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

## What is verified, and what is not

**Verified here, without an Azure subscription** (`bash scripts/verify.sh`, needs Docker; also runs in CI):

- `terraform fmt`, `init`, `validate` against the real provider schemas (azurerm 4.81, azuread 3.10): every argument exists and has a valid value.
- `terraform test` with mocked providers: 15 runs that assert the security and resilience properties the design depends on (database private, Entra-only, zone-redundant, locked; registry and vault without stored credentials; two replicas minimum; `AUTH_MODE=oidc`, `DEMO=0`; only the application subnet reaches the database; PKCE-only browser app; one assignment per mapped group; bad input is refused). A deliberate change to one of those properties makes a test fail (checked).
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

## Before the first apply

1. **State storage.** Create a storage account for state (outside this configuration), with blob versioning and soft delete, public access off, and give the people and pipeline that run Terraform *Storage Blob Data Contributor*. `backend.tf` signs in with Entra, no key.
2. **Resource providers.** A subscription owner registers once: `Microsoft.App`, `Microsoft.ContainerRegistry`, `Microsoft.DBforPostgreSQL`, `Microsoft.KeyVault`, `Microsoft.ManagedIdentity`, `Microsoft.Network`, `Microsoft.OperationalInsights`, `Microsoft.Insights`, `Microsoft.Consumption`. The configuration does not register them (`resource_provider_registrations = "none"`).
3. **Who runs Terraform.** On the subscription or resource group: *Contributor* and *User Access Administrator* (it creates role assignments). In Entra: *Application Administrator* (it creates the two app registrations and, if used, group-to-role assignments). Use a person for the first apply and a pipeline identity afterwards.
4. **An Entra group for database administration** (`dba_group_object_id`). Password sign-in is disabled, so without it nobody can create database roles.
5. **Quota and region.** The region must have availability zones. Check Container Apps and `GP_Standard_D2ds_v5` quota in it.
6. Copy `terraform.tfvars.example` to `<environment>.tfvars` and fill it in.

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
| Front Door + WAF in front of the app | The company wants WAF rules, a custom domain with managed certificate, or to hide the container app address. Today every request needs an Entra token, TLS terminates at the platform ingress,. |
| Private endpoints for the registry and the vault | Security policy forbids their public endpoints. Needs ACR Premium and self-hosted pipeline runners. Today: registry has no anonymous or admin access, vault firewall admits only the application subnet. |
| Egress firewall | Policy requires an allow-list of outbound destinations. The container subnet's outbound is unrestricted; the database subnet accepts only the application subnet. |
| A second region | An RTO shorter than "restore from geo-redundant backup in the paired region" (hours) is required. The queue is the database, so a warm standby is a read replica plus a second container environment. |
| Tracing / Application Insights | A real gateway adds latency worth attributing. Logs, `/metrics` and the failure alert cover the current needs. |
| Landing zone, Policy, Defender for Cloud | These belong to the subscription, not to this workload; the tag rules (`owner`, `cost_centre`) and locks follow the CAF landing-zone conventions. |
| Narrower deployment identity | Replace *Contributor on the resource group* with a custom role limited to updating the three container resources and pushing to the registry. |
