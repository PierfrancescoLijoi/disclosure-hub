# Landing zone: the tenant-level rules the workload inherits

`infra/azure` is one workload (Disclosure Hub) in one subscription. The things an organisation decides **once** for
every workload, and that a workload must not decide for itself, live here, in a separate Terraform root with its own
state and its own pipeline identity (tenant-level rights are not the workload pipeline's business):

| File | What |
|---|---|
| `main.tf` | A shallow management-group hierarchy: platform, landing zones (prod, nonprod), sandbox, decommissioned; subscriptions placed by `var.subscriptions` |
| `policy.tf` | Policy assignments inherited by everything below: approved regions, required tags on resource groups, Key Vault and registry not on the internet, Front Door tier. Built-ins found by display name |
| `rbac.tf`, `variables.tf` | Role assignments for **groups**; `Owner` is refused at org, landing zones and production |

```
<org>
|-- <org>-platform         connectivity (hub, firewall), identity, management (central logs)
|-- <org>-landing-zones
|   |-- <org>-prod         Disclosure Hub prod (infra/azure, environment = prod)
|   `-- <org>-nonprod      Disclosure Hub test and dev
|-- <org>-sandbox
`-- <org>-decommissioned
```

## How the workload fits in

- Put the workload's subscription id in `subscriptions.prod` or `.nonprod`; that is all the workload root needs to
  "live in" the landing zone. It still creates its own resource groups with the `owner` and `cost_centre` tags the policy
  asks for.
- `allowed_locations` must list the workload's region **and** its `dr_location`, plus `global` (Front Door).
- Policies start in **report-only** (`enforce_policies = false`): Azure Policy shows non-compliant resources and
  nothing is blocked. Read the compliance results for a few weeks, fix or exempt what they find, then set `true`. Two
  of them (Key Vault and registry public access) become `Deny`; the Front Door tier one is always audit, because a
  development environment may keep Standard on purpose.

## Verified, and not

`bash scripts/verify.sh` (Docker only): `fmt`, `validate`, 7 mocked-provider tests (hierarchy, report-first policies,
enforcement switch, roles by group, Owner refused over production, one place per subscription, `global` kept), `tflint`,
`trivy`, `checkov`. **Never applied.** Unproven until the first plan against a tenant:

1. The built-in policy display names resolve (a name Microsoft changed fails the plan loudly) and take the parameters
   passed (`effect`, `listOfAllowedLocations`, `tagName`).
2. The pipeline identity has the rights a tenant-level change needs (*Management Group Contributor* and *Resource
   Policy Contributor* at the org group, *User Access Administrator* for the role assignments, rights to move
   subscriptions). Use a person for the first apply.
3. Existing resources comply: run with `enforce_policies = false` first, always.
4. The Key Vault public-access policy becomes `Deny` when enforced, which blocks the first-secret bootstrap through `key_vault_allowed_ips` (`infra/azure`). Create the secrets before enforcing, or add a policy exemption for that vault for the hour it takes.

## Not here, on purpose

The hub network and Azure Firewall (egress filtering), Defender for Cloud plans, central diagnostic settings and the
identity landing zone are the platform team's, in the platform subscription. This root gives them the place to be
assigned (the `platform` group) and the inherited guardrails; it does not build them. The workload's NAT gateway gives
one egress address meanwhile (`infra/azure/README.md`, "Not included").

## Apply

```bash
cd infra/azure-landing-zone
terraform init -backend-config=... # see backend.tf
cp terraform.tfvars.example landing-zone.tfvars   # fill in
terraform plan -var-file=landing-zone.tfvars -out=lz.plan   # read it: it moves subscriptions
terraform apply lz.plan
```
