# Offline checks of the properties the design depends on. No cloud account is touched: the providers are
# mocked, so these prove the configuration says what the architecture document says, not that Azure
# accepts it (that is what the staged first apply in the README is for).

mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      tenant_id       = "11111111-1111-1111-1111-111111111111"
      subscription_id = "22222222-2222-2222-2222-222222222222"
      object_id       = "33333333-3333-3333-3333-333333333333"
      client_id       = "44444444-4444-4444-4444-444444444444"
    }
  }
  mock_resource "azurerm_resource_group" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test"
    }
  }
  mock_resource "azurerm_virtual_network" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.Network/virtualNetworks/vnet-dhub-test"
    }
  }
  mock_resource "azurerm_nat_gateway" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.Network/natGateways/natgw-dhub-test"
    }
  }
  mock_resource "azurerm_public_ip" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.Network/publicIPAddresses/pip-dhub-test-nat"
    }
  }
  mock_resource "azurerm_subnet" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.Network/virtualNetworks/vnet-dhub-test/subnets/snet-x"
    }
  }
  mock_resource "azurerm_network_security_group" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.Network/networkSecurityGroups/nsg-dhub-test-postgres"
    }
  }
  mock_resource "azurerm_private_dns_zone" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.Network/privateDnsZones/dhub-test.private.postgres.database.azure.com"
    }
  }
  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-x"
      principal_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
      client_id    = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    }
  }
  mock_resource "azurerm_container_registry" {
    defaults = {
      id           = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.ContainerRegistry/registries/acrdhubtest"
      login_server = "acrdhubtest.azurecr.io"
    }
  }
  mock_resource "azurerm_key_vault" {
    defaults = {
      id        = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.KeyVault/vaults/kv-dhubtest"
      vault_uri = "https://kv-dhubtest.vault.azure.net/"
    }
  }
  mock_resource "azurerm_postgresql_flexible_server" {
    defaults = {
      id   = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.DBforPostgreSQL/flexibleServers/psql-dhubtest"
      fqdn = "psql-dhubtest.postgres.database.azure.com"
    }
  }
  mock_resource "azurerm_log_analytics_workspace" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.OperationalInsights/workspaces/log-dhub-test"
    }
  }
  mock_resource "azurerm_container_app_environment" {
    defaults = {
      id             = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.App/managedEnvironments/cae-dhub-test"
      default_domain = "calmsea-1234.uksouth.azurecontainerapps.io"
    }
  }
  mock_resource "azurerm_container_app" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.App/containerApps/ca-dhub-test-api"
    }
  }
  mock_resource "azurerm_cdn_frontdoor_profile" {
    defaults = {
      id            = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.Cdn/profiles/afd-dhub-test"
      resource_guid = "11111111-aaaa-bbbb-cccc-dddddddddddd"
    }
  }
  mock_resource "azurerm_cdn_frontdoor_endpoint" {
    defaults = {
      id        = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.Cdn/profiles/afd-dhub-test/afdEndpoints/fde-dhubtest"
      host_name = "fde-dhubtest.z01.azurefd.net"
    }
  }
  mock_resource "azurerm_cdn_frontdoor_origin_group" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.Cdn/profiles/afd-dhub-test/originGroups/api"
    }
  }
  mock_resource "azurerm_cdn_frontdoor_origin" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.Cdn/profiles/afd-dhub-test/originGroups/api/origins/api"
    }
  }
  mock_resource "azurerm_cdn_frontdoor_firewall_policy" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.Network/frontDoorWebApplicationFirewallPolicies/afdwafdhubtest"
    }
  }
  mock_resource "azurerm_email_communication_service" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.Communication/emailServices/acs-email-dhub-test"
    }
  }
  mock_resource "azurerm_email_communication_service_domain" {
    defaults = {
      id                      = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.Communication/emailServices/acs-email-dhub-test/domains/AzureManagedDomain"
      mail_from_sender_domain = "0a1b2c3d.azurecomm.net"
    }
  }
  mock_resource "azurerm_communication_service" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.Communication/communicationServices/acs-dhub-test"
    }
  }
  mock_resource "azurerm_monitor_action_group" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.Insights/actionGroups/ag-dhub-test-ops"
    }
  }
  override_resource {
    target = azurerm_user_assigned_identity.migrate
    values = {
      name         = "id-dhub-test-migrate"
      id           = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-dhub-test-migrate"
      principal_id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
      client_id    = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    }
  }
  override_resource {
    target = azurerm_user_assigned_identity.app
    values = {
      name         = "id-dhub-test-app"
      id           = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-dhub-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-dhub-test-app"
      principal_id = "cccccccc-cccc-cccc-cccc-cccccccccccc"
      client_id    = "cccccccc-cccc-cccc-cccc-cccccccccccc"
    }
  }
}

mock_provider "azuread" {
  mock_resource "azuread_application" {
    defaults = {
      id        = "/applications/dddddddd-dddd-dddd-dddd-dddddddddddd"
      client_id = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"
      object_id = "ffffffff-ffff-ffff-ffff-ffffffffffff"
    }
  }
  mock_resource "azuread_service_principal" {
    defaults = {
      id        = "/servicePrincipals/11111111-1111-1111-1111-111111111111"
      object_id = "11111111-1111-1111-1111-111111111111"
    }
  }
}

variables {
  environment         = "test"
  tags                = { owner = "platform@example.com", cost_centre = "ir" }
  default_company_id  = "acme"
  issuers_json        = "[{\"id\":\"acme\",\"name\":\"Acme plc\",\"profiles\":{}}]"
  dba_group_object_id = "55555555-5555-5555-5555-555555555555"
  alert_email         = "ops@example.com"
  github_repository   = "acme/disclosure-hub"
  role_groups         = { author = "66666666-6666-6666-6666-666666666666", publisher = "77777777-7777-7777-7777-777777777777" }
}

run "database_is_private_entra_only_and_zone_redundant" {
  command = apply

  assert {
    condition     = azurerm_postgresql_flexible_server.main.authentication[0].password_auth_enabled == false
    error_message = "The database must not accept passwords."
  }
  assert {
    condition     = azurerm_postgresql_flexible_server.main.authentication[0].active_directory_auth_enabled
    error_message = "Entra authentication must be on."
  }
  assert {
    condition     = azurerm_postgresql_flexible_server.main.public_network_access_enabled == false
    error_message = "The database must have no public endpoint."
  }
  assert {
    condition     = azurerm_postgresql_flexible_server.main.high_availability[0].mode == "ZoneRedundant"
    error_message = "The database must have a zone-redundant standby."
  }
  assert {
    condition     = azurerm_postgresql_flexible_server.main.backup_retention_days >= 7 && azurerm_postgresql_flexible_server.main.geo_redundant_backup_enabled
    error_message = "Backups must be kept at least 7 days and copied to the paired region."
  }
  assert {
    condition     = length(azurerm_management_lock.postgres) == 1 && length(azurerm_management_lock.vault) == 1
    error_message = "The database and the vault must be locked against deletion by default."
  }
}

run "network_lets_only_the_app_subnet_reach_the_database" {
  command = apply

  assert {
    condition     = one([for r in azurerm_network_security_group.postgres.security_rule : r if r.access == "Allow"]).destination_port_range == "5432"
    error_message = "Exactly one allow rule, to 5432."
  }
  assert {
    condition     = one([for r in azurerm_network_security_group.postgres.security_rule : r if r.access == "Allow"]).source_address_prefix == "10.40.0.0/23"
    error_message = "The allow rule must name the application subnet only."
  }
  assert {
    condition     = azurerm_subnet.aca.address_prefixes[0] == "10.40.0.0/23" && azurerm_subnet.postgres.address_prefixes[0] == "10.40.2.0/28"
    error_message = "Subnets must not overlap and the Container Apps subnet must be a /23."
  }
}

run "workloads_have_no_stored_credentials" {
  command = apply

  assert {
    condition     = azurerm_container_registry.main.admin_enabled == false && azurerm_container_registry.main.anonymous_pull_enabled == false
    error_message = "The registry must use identities only."
  }
  assert {
    condition     = azurerm_key_vault.main.purge_protection_enabled && azurerm_key_vault.main.rbac_authorization_enabled
    error_message = "The vault needs purge protection and RBAC."
  }
  assert {
    condition     = azurerm_key_vault.main.network_acls[0].default_action == "Deny"
    error_message = "The vault firewall must deny by default."
  }
  assert {
    condition     = !anytrue([for e in azurerm_container_app.api.template[0].container[0].env : e.value != null && can(regex("PASSWORD|SECRET|KEY", e.name))])
    error_message = "No password, secret or key may be a plain environment value of the API (a reference to a vault secret is fine)."
  }
  assert {
    condition     = !anytrue([for e in azurerm_container_app_job.migrate.template[0].container[0].env : can(regex("PASSWORD|SECRET|KEY", e.name))])
    error_message = "The migrate job must not carry a password either."
  }
}

run "api_and_worker_are_redundant_and_use_real_authentication" {
  command = apply

  assert {
    condition     = azurerm_container_app.api.template[0].min_replicas >= 2 && azurerm_container_app.worker.template[0].min_replicas >= 2
    error_message = "Two replicas minimum so a zone loss or a deploy never leaves zero."
  }
  assert {
    condition     = azurerm_container_app_environment.main.zone_redundancy_enabled
    error_message = "The container environment must be zone redundant."
  }
  assert {
    condition     = one([for e in azurerm_container_app.api.template[0].container[0].env : e if e.name == "AUTH_MODE"]).value == "oidc"
    error_message = "Azure must run with OIDC authentication, never demo personas."
  }
  assert {
    condition     = one([for e in azurerm_container_app.api.template[0].container[0].env : e if e.name == "DEMO"]).value == "0"
    error_message = "Demo controls must be off."
  }
  assert {
    condition     = one([for e in azurerm_container_app.api.template[0].container[0].env : e if e.name == "DATABASE_AUTH"]).value == "azure-managed-identity"
    error_message = "The database password must be an Entra token."
  }
  assert {
    condition     = azurerm_container_app.api.ingress[0].allow_insecure_connections == false
    error_message = "Plain HTTP must not be accepted."
  }
  assert {
    condition     = length(azurerm_container_app.worker.ingress) == 0
    error_message = "The worker must have no ingress."
  }
  assert {
    condition     = azurerm_container_app.api.identity[0].identity_ids != azurerm_container_app_job.migrate.identity[0].identity_ids
    error_message = "The schema owner (migrate) and the runtime identity must differ."
  }
}

run "entra_registrations_define_roles_and_pkce_only" {
  command = apply

  assert {
    condition     = length(azuread_application.api.app_role) == 5
    error_message = "Five application roles."
  }
  assert {
    condition     = azuread_application.api.api[0].requested_access_token_version == 2
    error_message = "The server verifies v2.0 tokens."
  }
  assert {
    condition     = azuread_service_principal.api.app_role_assignment_required
    error_message = "Only people assigned a role may get a token."
  }
  assert {
    condition     = length(azuread_application.web.single_page_application[0].redirect_uris) >= 1 && alltrue([for u in azuread_application.web.single_page_application[0].redirect_uris : startswith(u, "https://")])
    error_message = "Redirect URIs must be https."
  }
  assert {
    condition     = length(azuread_app_role_assignment.group) == 2
    error_message = "One assignment per mapped group."
  }
  assert {
    condition     = length(azurerm_federated_identity_credential.deploy) == 1 && azurerm_federated_identity_credential.deploy[0].subject == "repo:acme/disclosure-hub:environment:test"
    error_message = "The deployment identity trusts one repository and one environment."
  }
}

run "alerts_exist_for_what_needs_a_person" {
  command = apply

  assert {
    condition     = azurerm_monitor_metric_alert.api_replicas.criteria[0].threshold == 2 && azurerm_monitor_metric_alert.worker_replicas.criteria[0].threshold == 2
    error_message = "Replica alerts must match the floor."
  }
  assert {
    condition     = azurerm_monitor_scheduled_query_rules_alert_v2.publication_failed.severity == 1
    error_message = "A failed publication is severity 1."
  }
  assert {
    condition     = azurerm_consumption_budget_resource_group.main.amount == 600
    error_message = "The default budget applies."
  }
}

run "no_ci_identity_without_a_repository" {
  command = apply
  variables {
    github_repository = null
  }

  assert {
    condition     = length(azurerm_user_assigned_identity.deploy) == 0 && length(azurerm_role_assignment.deploy_contributor) == 0
    error_message = "No deployment identity without a repository."
  }
}

run "anthropic_key_comes_from_the_vault" {
  command = apply
  variables {
    ai_provider = "anthropic"
  }

  assert {
    condition     = alltrue([for s in azurerm_container_app.api.secret : s.key_vault_secret_id != null]) && length(azurerm_container_app.api.secret) == 2
    error_message = "The provider key must be a Key Vault reference, never a value."
  }
}

run "locks_can_be_removed_deliberately" {
  command = apply
  variables {
    enable_resource_locks = false
  }

  assert {
    condition     = length(azurerm_management_lock.postgres) == 0
    error_message = "Setting the switch to false removes the locks."
  }
}

# ------------------------------------------------------------------ events, agents and readers

run "each_consumer_set_is_its_own_app_with_no_ingress_and_no_stored_secret" {
  command = apply

  assert {
    condition     = length(azurerm_container_app.events) == 2 && contains(keys(azurerm_container_app.events), "notifier") && contains(keys(azurerm_container_app.events), "agents")
    error_message = "The default consumer sets are notifier and agents, one app each."
  }
  assert {
    condition     = alltrue([for k, a in azurerm_container_app.events : length(a.ingress) == 0 && a.template[0].min_replicas >= 1])
    error_message = "Event consumers have no ingress and never scale to zero (nothing would wake a poller)."
  }
  assert {
    condition     = one([for e in azurerm_container_app.events["notifier"].template[0].container[0].env : e if e.name == "REACTOR_CONSUMERS"]).value == "notifier" && one([for e in azurerm_container_app.events["notifier"].template[0].container[0].env : e if e.name == "ROLE"]).value == "events"
    error_message = "A set runs ROLE=events with exactly the consumers it names."
  }
  assert {
    condition     = one([for e in azurerm_container_app.events["agents"].template[0].container[0].env : e if e.name == "AGENTS"]).value == "precheck"
    error_message = "The agents set auto-runs the pre-check agent."
  }
  assert {
    condition     = !anytrue([for k, a in azurerm_container_app.events : anytrue([for e in a.template[0].container[0].env : e.value != null && can(regex("PASSWORD|SECRET|KEY", e.name))])])
    error_message = "Event consumers hold no secret as a plain value."
  }
  assert {
    condition     = alltrue([for k, a in azurerm_container_app.events : one([for e in a.template[0].container[0].env : e if e.name == "WEBHOOK_ALLOW_PRIVATE"]).value == "0"])
    error_message = "Reader webhooks to private addresses are demo-only and must be off."
  }
  assert {
    condition     = length(azurerm_monitor_metric_alert.events_replicas) == 2 && azurerm_monitor_scheduled_query_rules_alert_v2.dead_delivery.severity == 1
    error_message = "Each set has a replica alert, and dead deliveries page someone."
  }
}

run "a_new_agent_is_one_more_entry_and_nothing_else" {
  command = apply
  variables {
    consumer_sets = {
      notifier = { consumers = "notifier" }
      agents   = { consumers = "agent:precheck", agents = "precheck" }
      redactor = { consumers = "agent:redactor", agents = "redactor", cpu = 0.5, memory = "1Gi" }
    }
  }

  assert {
    condition     = length(azurerm_container_app.events) == 3 && length(azurerm_monitor_metric_alert.events_replicas) == 3
    error_message = "A third consumer set gets its own app and its own alert."
  }
  assert {
    condition     = azurerm_container_app.api.template[0].min_replicas == 2 && azurerm_container_app.worker.template[0].min_replicas == 2
    error_message = "The api and worker are untouched by a new consumer set."
  }
}

run "mail_goes_through_the_managed_identity_not_a_password" {
  command = apply

  assert {
    condition     = one([for e in azurerm_container_app.api.template[0].container[0].env : e if e.name == "EMAIL_TRANSPORT"]).value == "acs"
    error_message = "Production mail uses Azure Communication Services."
  }
  assert {
    condition     = !anytrue([for e in azurerm_container_app.api.template[0].container[0].env : contains(["SMTP_URL", "ACS_CONNECTION_STRING"], e.name)])
    error_message = "There must be no SMTP password or connection string."
  }
  assert {
    condition     = azurerm_role_assignment.app_send_email[0].role_definition_name == "Communication and Email Service Owner" && azurerm_role_assignment.app_send_email[0].principal_id == azurerm_user_assigned_identity.app.principal_id
    error_message = "The app identity, and only it, may send."
  }
  assert {
    condition     = azurerm_email_communication_service_domain.main[0].domain_management == "AzureManaged"
    error_message = "The default sender is an Azure-managed domain (works without DNS)."
  }
  assert {
    condition     = one([for s in azurerm_container_app.api.secret : s if s.name == "reader-token-key"]).key_vault_secret_id != null
    error_message = "The reader token key is a Key Vault reference."
  }
}

run "mail_can_be_switched_off" {
  command = apply
  variables {
    enable_reader_email = false
  }

  assert {
    condition     = one([for e in azurerm_container_app.api.template[0].container[0].env : e if e.name == "EMAIL_TRANSPORT"]).value == "off" && length(azurerm_communication_service.main) == 0 && length(azurerm_role_assignment.app_send_email) == 0
    error_message = "Without reader email there is no Communication Services and no role."
  }
}

run "the_edge_caches_public_reads_and_limits_the_form" {
  command = apply

  assert {
    condition     = azurerm_cdn_frontdoor_route.public[0].patterns_to_match == tolist(["/api/public/*"]) && length(azurerm_cdn_frontdoor_route.public[0].cache) == 1
    error_message = "Only the public read routes are cached."
  }
  assert {
    condition     = length(azurerm_cdn_frontdoor_route.app[0].cache) == 0
    error_message = "The staff API and the web app are never cached."
  }
  assert {
    condition     = azurerm_cdn_frontdoor_firewall_policy.main[0].mode == "Prevention" && one(azurerm_cdn_frontdoor_firewall_policy.main[0].custom_rule).rate_limit_threshold == 20
    error_message = "The WAF blocks (not just logs) and rate limits the subscription form."
  }
  assert {
    condition     = one([for e in azurerm_container_app.api.template[0].container[0].env : e if e.name == "TRUST_PROXY"]).value == "2" && startswith(one([for e in azurerm_container_app.api.template[0].container[0].env : e if e.name == "PUBLIC_BASE_URL"]).value, "https://")
    error_message = "Behind Front Door two proxy hops are trusted and links use https."
  }
  assert {
    condition     = one([for e in azurerm_container_app.api.template[0].container[0].env : e if e.name == "EDGE_ID"]).value == "11111111-aaaa-bbbb-cccc-dddddddddddd"
    error_message = "The api accepts only requests that carry the Front Door id, so the WAF and cache cannot be skipped."
  }
  assert {
    condition     = alltrue([for k, a in azurerm_container_app.events : one([for e in a.template[0].container[0].env : e if e.name == "AGENTS"]).value == "precheck"]) && one([for e in azurerm_container_app.api.template[0].container[0].env : e if e.name == "AGENTS"]).value == "precheck"
    error_message = "Every process, api included, gets the same AGENTS: the writer of an event decides who receives it."
  }
}

run "without_front_door_the_app_serves_itself" {
  command = apply
  variables {
    enable_front_door = false
    private_ingress   = false
  }

  assert {
    condition     = length(azurerm_cdn_frontdoor_profile.main) == 0 && length(azurerm_cdn_frontdoor_firewall_policy.main) == 0
    error_message = "No edge resources when it is switched off."
  }
  assert {
    condition     = one([for e in azurerm_container_app.api.template[0].container[0].env : e if e.name == "TRUST_PROXY"]).value == "1" && strcontains(one([for e in azurerm_container_app.api.template[0].container[0].env : e if e.name == "PUBLIC_BASE_URL"]).value, "azurecontainerapps.io")
    error_message = "One proxy hop, and links point at the app's own address."
  }
}

# ------------------------------------------------------------------ private network, edge tier, second region

run "the_data_plane_is_private_and_egress_has_one_address" {
  command = apply

  assert {
    condition     = azurerm_container_registry.main.sku == "Premium" && azurerm_container_registry.main.public_network_access_enabled == false && azurerm_container_registry.main.admin_enabled == false
    error_message = "The registry is Premium, closed to the internet and has no shared password."
  }
  assert {
    condition     = length(azurerm_container_registry_agent_pool.build) == 1 && length(azurerm_private_endpoint.acr) == 1 && length(azurerm_private_endpoint.vault) == 1
    error_message = "Builds run inside the network and both the registry and the vault have private endpoints."
  }
  assert {
    condition     = azurerm_key_vault.main.public_network_access_enabled == false && length(azurerm_key_vault.main.network_acls[0].ip_rules) == 0
    error_message = "The vault is closed to the internet unless an operator address is listed."
  }
  assert {
    condition     = length(azurerm_nat_gateway.main) == 1 && length(azurerm_subnet_nat_gateway_association.aca) == 1
    error_message = "Outbound traffic leaves through the NAT gateway."
  }
  assert {
    condition     = azurerm_container_app_environment.main.public_network_access == "Disabled" && length(azurerm_network_security_rule.aca_https_from_internet) == 0
    error_message = "The environment has no public address and no subnet rule admits the internet."
  }
}

run "the_edge_is_premium_with_managed_rules_and_a_private_origin" {
  command = apply

  assert {
    condition     = azurerm_cdn_frontdoor_profile.main[0].sku_name == "Premium_AzureFrontDoor"
    error_message = "Private Link and the managed rule sets need Premium."
  }
  assert {
    condition     = toset([for r in azurerm_cdn_frontdoor_firewall_policy.main[0].managed_rule : "${r.type}:${r.version}"]) == toset(["Microsoft_DefaultRuleSet:2.1", "Microsoft_BotManagerRuleSet:1.1"]) && alltrue([for r in azurerm_cdn_frontdoor_firewall_policy.main[0].managed_rule : r.action == "Log"])
    error_message = "Both managed rule sets are attached, in Log first."
  }
  assert {
    condition     = one(azurerm_cdn_frontdoor_origin.api[0].private_link).target_type == "managedEnvironments"
    error_message = "The origin is reached over Private Link to the Container Apps environment."
  }
  assert {
    condition     = one([for e in azurerm_container_app.api.template[0].container[0].env : e if e.name == "EDGE_ID_MODE"]).value == "log"
    error_message = "The edge id starts in log mode so a wrong header cannot lock everyone out."
  }
}

run "edge_id_can_be_enforced" {
  command = apply
  variables {
    edge_id_mode = "enforce"
  }

  assert {
    condition     = one([for e in azurerm_container_app.api.template[0].container[0].env : e if e.name == "EDGE_ID_MODE"]).value == "enforce"
    error_message = "enforce is passed to the app."
  }
}

run "the_waf_can_block" {
  command = apply
  variables {
    waf_managed_rules_action = "Block"
  }

  assert {
    condition     = alltrue([for r in azurerm_cdn_frontdoor_firewall_policy.main[0].managed_rule : r.action == "Block"])
    error_message = "Managed rules block when asked to."
  }
}

run "a_cheap_development_environment_stays_public_and_standard" {
  command = apply
  variables {
    private_data_plane = false
    private_ingress    = false
    waf_managed_rules  = false
  }

  assert {
    condition     = azurerm_container_registry.main.sku == "Standard" && azurerm_container_registry.main.public_network_access_enabled == true && length(azurerm_container_registry_agent_pool.build) == 0 && length(azurerm_private_endpoint.acr) == 0
    error_message = "Without the private data plane the registry is Standard and public, with no endpoints or agent pool."
  }
  assert {
    condition     = azurerm_cdn_frontdoor_profile.main[0].sku_name == "Standard_AzureFrontDoor" && length(azurerm_cdn_frontdoor_firewall_policy.main[0].managed_rule) == 0 && length(azurerm_nat_gateway.main) == 0
    error_message = "Standard edge, no managed rules, no NAT gateway."
  }
  assert {
    condition     = azurerm_container_app_environment.main.public_network_access == "Enabled" && length(azurerm_network_security_rule.aca_https_from_internet) == 1
    error_message = "Public ingress admits HTTPS only."
  }
}

run "an_operator_address_can_open_the_vault_for_the_first_secrets" {
  command = apply
  variables {
    key_vault_allowed_ips = ["203.0.113.7"]
  }

  assert {
    condition     = azurerm_key_vault.main.public_network_access_enabled == true && azurerm_key_vault.main.network_acls[0].default_action == "Deny" && azurerm_key_vault.main.network_acls[0].ip_rules == toset(["203.0.113.7"])
    error_message = "Only the listed address gets in, the firewall still denies by default."
  }
}

run "a_private_environment_needs_the_edge" {
  command = plan
  variables {
    enable_front_door = false
  }
  expect_failures = [azurerm_container_app_environment.main]
}

run "the_second_region_is_a_replica_that_fails_over_by_decision" {
  command = apply
  variables {
    dr_location = "northeurope"
  }

  assert {
    condition     = azurerm_postgresql_flexible_server.dr[0].create_mode == "Replica" && azurerm_postgresql_flexible_server.dr[0].public_network_access_enabled == false
    error_message = "The second region holds a private read replica of the primary."
  }
  assert {
    condition     = azurerm_container_app.dr_api[0].template[0].min_replicas == 1 && azurerm_container_app.dr_worker[0].template[0].min_replicas == 0 && alltrue([for k, a in azurerm_container_app.dr_events : a.template[0].min_replicas == 0])
    error_message = "Only the API runs in the standby region; writers wait for the promotion."
  }
  assert {
    condition     = azurerm_cdn_frontdoor_origin.dr[0].priority == 2 && azurerm_cdn_frontdoor_origin.api[0].priority == 1 && length(azurerm_cdn_frontdoor_route.app[0].cdn_frontdoor_origin_ids) == 2
    error_message = "Front Door prefers the primary and falls back to the second region."
  }
  assert {
    condition     = length(azurerm_container_registry.main.georeplications) == 1 && length(azurerm_monitor_metric_alert.postgres_replica_lag) == 1
    error_message = "Images are replicated to the second region and the replica lag is alerted."
  }
  assert {
    condition     = length(azurerm_virtual_network_peering.primary_to_dr) == 1 && length(azurerm_virtual_network_peering.dr_to_primary) == 1 && length(azurerm_management_lock.postgres_dr) == 1
    error_message = "The networks are peered for replication and the replica is protected from deletion."
  }
}

run "there_is_no_second_region_by_default" {
  command = apply

  assert {
    condition     = length(azurerm_resource_group.dr) == 0 && length(azurerm_postgresql_flexible_server.dr) == 0 && length(azurerm_cdn_frontdoor_origin.dr) == 0 && length(azurerm_container_registry.main.georeplications) == 0
    error_message = "Nothing is created for a region nobody asked for."
  }
}

run "the_second_region_must_be_another_region" {
  command = plan
  variables {
    dr_location = "uksouth"
  }
  expect_failures = [azurerm_resource_group.dr]
}

run "the_second_region_needs_the_private_data_plane" {
  command = plan
  variables {
    dr_location        = "northeurope"
    private_data_plane = false
  }
  expect_failures = [azurerm_resource_group.dr]
}

run "a_read_replica_for_public_reads_is_opt_in" {
  command = apply

  assert {
    condition     = length(azurerm_postgresql_flexible_server.read) == 0 && length([for e in azurerm_container_app.api.template[0].container[0].env : e if e.name == "READ_DATABASE_URL"]) == 0
    error_message = "No read replica and no READ_DATABASE_URL by default."
  }
}

run "the_read_replica_is_wired_to_the_api_only" {
  command = apply
  variables {
    read_replica = true
  }

  assert {
    condition     = azurerm_postgresql_flexible_server.read[0].create_mode == "Replica" && length([for e in azurerm_container_app.api.template[0].container[0].env : e if e.name == "READ_DATABASE_URL"]) == 1
    error_message = "The api gets READ_DATABASE_URL when the replica exists."
  }
  assert {
    condition     = alltrue([for k, a in azurerm_container_app.events : length([for e in a.template[0].container[0].env : e if e.name == "READ_DATABASE_URL"]) == 0])
    error_message = "Consumers write, so they stay on the primary."
  }
}

run "the_database_has_an_early_warning_before_it_is_the_bottleneck" {
  command = apply

  assert {
    condition     = azurerm_monitor_metric_alert.postgres_cpu_sustained.criteria[0].threshold == 60 && azurerm_monitor_metric_alert.postgres_cpu_sustained.severity == 3
    error_message = "Sustained CPU above 60 % is the signal to look at replicas and Service Bus (docs/adr/0001)."
  }
}

# ------------------------------------------------------------------ bad input is refused

run "rejects_unknown_environment" {
  command = plan
  variables {
    environment = "staging"
  }
  expect_failures = [var.environment]
}

run "rejects_a_single_replica_api" {
  command = plan
  variables {
    api_replicas = { min = 1, max = 2 }
  }
  expect_failures = [var.api_replicas]
}

run "rejects_burstable_database" {
  command = plan
  variables {
    postgres_sku = "B_Standard_B2s"
  }
  expect_failures = [var.postgres_sku]
}

run "rejects_tags_without_an_owner" {
  command = plan
  variables {
    tags = { cost_centre = "ir" }
  }
  expect_failures = [var.tags]
}

run "rejects_plain_http_redirects" {
  command = plan
  variables {
    extra_redirect_uris = ["http://hub.example.com/"]
  }
  expect_failures = [var.extra_redirect_uris]
}

run "rejects_unknown_role_group" {
  command = plan
  variables {
    role_groups = { janitor = "66666666-6666-6666-6666-666666666666" }
  }
  expect_failures = [var.role_groups]
}

run "rejects_a_consumer_set_that_would_run_everything" {
  command = plan
  variables {
    consumer_sets = { all = { consumers = " " } }
  }
  expect_failures = [var.consumer_sets]
}

run "rejects_a_scaled_to_zero_consumer_set" {
  command = plan
  variables {
    consumer_sets = { notifier = { consumers = "notifier", min_replicas = 0 } }
  }
  expect_failures = [var.consumer_sets]
}

run "rejects_more_consumer_replicas_than_the_database_can_serve" {
  command = plan
  variables {
    consumer_sets = { a = { consumers = "a", max_replicas = 4 }, bb = { consumers = "b", max_replicas = 4 } }
  }
  expect_failures = [var.consumer_sets]
}

run "rejects_an_unknown_edge_id_mode" {
  command = plan
  variables {
    edge_id_mode = "sometimes"
  }
  expect_failures = [var.edge_id_mode]
}

run "rejects_an_unknown_waf_action" {
  command = plan
  variables {
    waf_managed_rules_action = "Allow"
  }
  expect_failures = [var.waf_managed_rules_action]
}

run "rejects_a_second_region_without_zones" {
  command = plan
  variables {
    dr_location = "brazilsouth"
  }
  expect_failures = [var.dr_location]
}
