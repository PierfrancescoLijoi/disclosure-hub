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
    condition     = !anytrue([for e in azurerm_container_app.api.template[0].container[0].env : can(regex("PASSWORD|SECRET|KEY", e.name))])
    error_message = "No password, secret or key may be an environment variable of the API with the default provider."
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
    condition     = one(azurerm_container_app.api.secret).key_vault_secret_id != null && length(azurerm_container_app.api.secret) == 1
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
