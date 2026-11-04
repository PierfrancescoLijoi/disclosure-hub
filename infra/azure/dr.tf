# A second region, ready to take over. Off unless dr_location is set.
#
# What runs there while the primary region is healthy: a PostgreSQL read replica (asynchronous, so a regional loss
# can lose the last seconds of writes: the RPO is the replica lag, alerted at 5 minutes), the registry's replica,
# and the container apps with the API at its floor and everything else at zero. Front Door lists the second
# region's API as a lower-priority origin: it gets traffic only when the primary origin fails its probe, and
# until the replica is promoted it serves the archive and the feed (reads) from the replica.
#
# A regional failover is a decision a person takes (scripts/dr-failover.sh, docs/DR.md): promoting the replica
# cannot be undone, and an automatic switch on a probe blip would split the data. RTO is the time to decide
# plus about 15 minutes of promotion and scale-up; neither number has been measured on Azure (README, first-apply
# items). The region pair is a choice: northeurope leaves the UK, so data residency must agree before using it.

locals {
  dr              = var.dr_location != null
  dr_aca_cidr     = cidrsubnet(var.dr_address_space, 1, 0)
  dr_pg_cidr      = cidrsubnet(var.dr_address_space, 6, 32)
  dr_pe_cidr      = cidrsubnet(var.dr_address_space, 6, 33)
  dr_database_url = local.dr ? "postgres://${azurerm_user_assigned_identity.app.name}@${azurerm_postgresql_flexible_server.dr[0].fqdn}:5432/${azurerm_postgresql_flexible_server_database.hub.name}" : null
  dr_sku          = coalesce(var.dr_postgres_sku, var.postgres_sku)
  dr_origin_ids   = azurerm_cdn_frontdoor_origin.dr[*].id
}

resource "azurerm_resource_group" "dr" {
  count    = local.dr ? 1 : 0
  name     = "rg-${local.name}-dr"
  location = var.dr_location
  tags     = merge(local.tags, { role = "disaster-recovery" })

  lifecycle {
    precondition {
      condition     = var.dr_location != var.location
      error_message = "dr_location must be a different region from location."
    }
    precondition {
      condition     = var.private_data_plane
      error_message = "The second region reads images from the registry's geo-replica and secrets through private endpoints: it needs private_data_plane = true (Premium registry)."
    }
    precondition {
      condition     = var.dr_address_space != var.address_space
      error_message = "dr_address_space must not be the same as address_space: the two networks are peered."
    }
  }
}

# ------------------------------------------------------------------ network

resource "azurerm_virtual_network" "dr" {
  count               = local.dr ? 1 : 0
  name                = "vnet-${local.name}-dr"
  location            = azurerm_resource_group.dr[0].location
  resource_group_name = azurerm_resource_group.dr[0].name
  address_space       = [var.dr_address_space]
  tags                = local.tags
}

resource "azurerm_subnet" "dr_aca" {
  count                = local.dr ? 1 : 0
  name                 = "snet-aca"
  resource_group_name  = azurerm_resource_group.dr[0].name
  virtual_network_name = azurerm_virtual_network.dr[0].name
  address_prefixes     = [local.dr_aca_cidr]

  delegation {
    name = "container-apps"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "dr_postgres" {
  count                = local.dr ? 1 : 0
  name                 = "snet-postgres"
  resource_group_name  = azurerm_resource_group.dr[0].name
  virtual_network_name = azurerm_virtual_network.dr[0].name
  address_prefixes     = [local.dr_pg_cidr]

  delegation {
    name = "postgres"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "dr_private_endpoints" {
  count                = local.dr ? 1 : 0
  name                 = "snet-pe"
  resource_group_name  = azurerm_resource_group.dr[0].name
  virtual_network_name = azurerm_virtual_network.dr[0].name
  address_prefixes     = [local.dr_pe_cidr]
}

# Nothing arrives from the internet (Front Door uses Private Link); Azure's default rules do the rest.
resource "azurerm_network_security_group" "dr_aca" {
  count               = local.dr ? 1 : 0
  name                = "nsg-${local.name}-dr-aca"
  location            = azurerm_resource_group.dr[0].location
  resource_group_name = azurerm_resource_group.dr[0].name
  tags                = local.tags
}

resource "azurerm_subnet_network_security_group_association" "dr_aca" {
  count                     = local.dr ? 1 : 0
  subnet_id                 = azurerm_subnet.dr_aca[0].id
  network_security_group_id = azurerm_network_security_group.dr_aca[0].id
}

# The replica accepts the application subnet (after a promotion) and the primary's subnet (replication,
# and the reverse direction when the roles swap back).
resource "azurerm_network_security_group" "dr_postgres" {
  count               = local.dr ? 1 : 0
  name                = "nsg-${local.name}-dr-postgres"
  location            = azurerm_resource_group.dr[0].location
  resource_group_name = azurerm_resource_group.dr[0].name
  tags                = local.tags

  security_rule {
    name                       = "allow-app-and-primary-to-postgres"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "5432"
    source_address_prefixes    = [local.dr_aca_cidr, local.pg_subnet_cidr, local.aca_subnet_cidr]
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "deny-everything-else-inbound"
    priority                   = 4000
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*" # lint:allow public this rule is a Deny
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "dr_postgres" {
  count                     = local.dr ? 1 : 0
  subnet_id                 = azurerm_subnet.dr_postgres[0].id
  network_security_group_id = azurerm_network_security_group.dr_postgres[0].id
}

resource "azurerm_public_ip" "dr_nat" {
  count               = local.dr ? 1 : 0
  name                = "pip-${local.name}-dr-nat"
  location            = azurerm_resource_group.dr[0].location
  resource_group_name = azurerm_resource_group.dr[0].name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.tags
}

resource "azurerm_nat_gateway" "dr" {
  count                   = local.dr ? 1 : 0
  name                    = "natgw-${local.name}-dr"
  location                = azurerm_resource_group.dr[0].location
  resource_group_name     = azurerm_resource_group.dr[0].name
  sku_name                = "Standard"
  idle_timeout_in_minutes = 10
  tags                    = local.tags
}

resource "azurerm_nat_gateway_public_ip_association" "dr" {
  count                = local.dr ? 1 : 0
  nat_gateway_id       = azurerm_nat_gateway.dr[0].id
  public_ip_address_id = azurerm_public_ip.dr_nat[0].id
}

resource "azurerm_subnet_nat_gateway_association" "dr_aca" {
  count          = local.dr ? 1 : 0
  subnet_id      = azurerm_subnet.dr_aca[0].id
  nat_gateway_id = azurerm_nat_gateway.dr[0].id
}

# Replication runs between the two servers' subnets, so the networks are peered (global peering).
resource "azurerm_virtual_network_peering" "primary_to_dr" {
  count                     = local.dr ? 1 : 0
  name                      = "to-dr"
  resource_group_name       = azurerm_resource_group.main.name
  virtual_network_name      = azurerm_virtual_network.main.name
  remote_virtual_network_id = azurerm_virtual_network.dr[0].id
}

resource "azurerm_virtual_network_peering" "dr_to_primary" {
  count                     = local.dr ? 1 : 0
  name                      = "to-primary"
  resource_group_name       = azurerm_resource_group.dr[0].name
  virtual_network_name      = azurerm_virtual_network.dr[0].name
  remote_virtual_network_id = azurerm_virtual_network.main.id
}

# Each region resolves the private names itself, so a primary-region DNS problem cannot break the second one.
resource "azurerm_private_dns_zone" "dr_postgres" {
  count               = local.dr ? 1 : 0
  name                = "${local.name}-dr.private.postgres.database.azure.com"
  resource_group_name = azurerm_resource_group.dr[0].name
  tags                = local.tags
}

resource "azurerm_private_dns_zone" "dr_acr" {
  count               = local.dr ? 1 : 0
  name                = "privatelink.azurecr.io"
  resource_group_name = azurerm_resource_group.dr[0].name
  tags                = local.tags
}

resource "azurerm_private_dns_zone" "dr_vault" {
  count               = local.dr ? 1 : 0
  name                = "privatelink.vaultcore.azure.net"
  resource_group_name = azurerm_resource_group.dr[0].name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "dr_postgres" {
  count                 = local.dr ? 1 : 0
  name                  = "link-${local.name}-dr"
  resource_group_name   = azurerm_resource_group.dr[0].name
  private_dns_zone_name = azurerm_private_dns_zone.dr_postgres[0].name
  virtual_network_id    = azurerm_virtual_network.dr[0].id
  tags                  = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "dr_acr" {
  count                 = local.dr ? 1 : 0
  name                  = "link-${local.name}-dr"
  resource_group_name   = azurerm_resource_group.dr[0].name
  private_dns_zone_name = azurerm_private_dns_zone.dr_acr[0].name
  virtual_network_id    = azurerm_virtual_network.dr[0].id
  tags                  = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "dr_vault" {
  count                 = local.dr ? 1 : 0
  name                  = "link-${local.name}-dr"
  resource_group_name   = azurerm_resource_group.dr[0].name
  private_dns_zone_name = azurerm_private_dns_zone.dr_vault[0].name
  virtual_network_id    = azurerm_virtual_network.dr[0].id
  tags                  = local.tags
}

resource "azurerm_private_endpoint" "dr_acr" {
  count               = local.dr ? 1 : 0
  name                = "pe-${local.name}-dr-acr"
  location            = azurerm_resource_group.dr[0].location
  resource_group_name = azurerm_resource_group.dr[0].name
  subnet_id           = azurerm_subnet.dr_private_endpoints[0].id
  tags                = local.tags

  private_service_connection {
    name                           = "acr"
    private_connection_resource_id = azurerm_container_registry.main.id
    subresource_names              = ["registry"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "acr"
    private_dns_zone_ids = [azurerm_private_dns_zone.dr_acr[0].id]
  }
}

resource "azurerm_private_endpoint" "dr_vault" {
  count               = local.dr ? 1 : 0
  name                = "pe-${local.name}-dr-kv"
  location            = azurerm_resource_group.dr[0].location
  resource_group_name = azurerm_resource_group.dr[0].name
  subnet_id           = azurerm_subnet.dr_private_endpoints[0].id
  tags                = local.tags

  private_service_connection {
    name                           = "vault"
    private_connection_resource_id = azurerm_key_vault.main.id
    subresource_names              = ["vault"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "vault"
    private_dns_zone_ids = [azurerm_private_dns_zone.dr_vault[0].id]
  }
}

# ------------------------------------------------------------------ database replica

# A read replica until it is promoted (az postgres flexible-server promote, in scripts/dr-failover.sh). It cannot
# run high availability while it is a replica; the script turns it on after the promotion.
resource "azurerm_postgresql_flexible_server" "dr" {
  # checkov:skip=CKV2_AZURE_57: VNet-integrated like the primary: no public endpoint.
  count               = local.dr ? 1 : 0
  name                = "psql-${local.unique}-dr"
  location            = azurerm_resource_group.dr[0].location
  resource_group_name = azurerm_resource_group.dr[0].name
  create_mode         = "Replica"
  source_server_id    = azurerm_postgresql_flexible_server.main.id
  sku_name            = local.dr_sku
  storage_mb          = var.postgres_storage_mb
  auto_grow_enabled   = true
  tags                = local.tags

  delegated_subnet_id           = azurerm_subnet.dr_postgres[0].id
  private_dns_zone_id           = azurerm_private_dns_zone.dr_postgres[0].id
  public_network_access_enabled = false

  lifecycle {
    # After a promotion the platform owns zone and role; do not fight it.
    ignore_changes = [zone, create_mode, source_server_id]
  }

  depends_on = [
    azurerm_postgresql_flexible_server.read, # one replica at a time from the same source
    azurerm_private_dns_zone_virtual_network_link.dr_postgres,
    azurerm_virtual_network_peering.primary_to_dr,
    azurerm_virtual_network_peering.dr_to_primary,
  ]
}

# After a promotion this server holds the only copy of the data written since: a mistaken destroy must not take it.
resource "azurerm_management_lock" "postgres_dr" {
  count      = local.dr && var.enable_resource_locks ? 1 : 0
  name       = "do-not-delete"
  scope      = azurerm_postgresql_flexible_server.dr[0].id
  lock_level = "CanNotDelete"
  notes      = "Second-region copy of the announcement records; the primary after a regional failover."
}

resource "azurerm_monitor_diagnostic_setting" "postgres_dr" {
  count                      = local.dr ? 1 : 0
  name                       = "to-log-analytics"
  target_resource_id         = azurerm_postgresql_flexible_server.dr[0].id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "PostgreSQLLogs"
  }
}

# ------------------------------------------------------------------ container apps

resource "azurerm_container_app_environment" "dr" {
  count                      = local.dr ? 1 : 0
  name                       = "cae-${local.name}-dr"
  location                   = azurerm_resource_group.dr[0].location
  resource_group_name        = azurerm_resource_group.dr[0].name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
  logs_destination           = "log-analytics"
  infrastructure_subnet_id   = azurerm_subnet.dr_aca[0].id
  zone_redundancy_enabled    = true
  public_network_access      = var.private_ingress ? "Disabled" : "Enabled"
  tags                       = local.tags

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }

  lifecycle {
    ignore_changes = [infrastructure_resource_group_name]
  }
}

# The API runs (at its floor) so Front Door has something healthy to fail over to; everything else is created
# at zero replicas and scaled by the failover script, so the standby costs one API and one database copy.
resource "azurerm_container_app" "dr_api" {
  count                        = local.dr ? 1 : 0
  name                         = "ca-${local.name}-api-dr"
  container_app_environment_id = azurerm_container_app_environment.dr[0].id
  resource_group_name          = azurerm_resource_group.dr[0].name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  dynamic "secret" {
    for_each = local.anthropic_secret ? [1] : []
    content {
      name                = "anthropic-api-key"
      key_vault_secret_id = "${azurerm_key_vault.main.vault_uri}secrets/${var.anthropic_secret_name}"
      identity            = azurerm_user_assigned_identity.app.id
    }
  }

  secret {
    name                = local.reader_token_secret.name
    key_vault_secret_id = local.reader_token_secret.key_vault_secret_id
    identity            = local.reader_token_secret.identity
  }

  ingress {
    external_enabled           = true
    target_port                = 3000
    transport                  = "auto"
    allow_insecure_connections = false

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 1
    max_replicas = var.api_replicas.max

    http_scale_rule {
      name                = "concurrency"
      concurrent_requests = "50"
    }

    container {
      name   = "api"
      image  = var.api_image
      cpu    = 0.5
      memory = "1Gi"

      dynamic "env" {
        for_each = merge(local.common_env, local.reader_env, {
          ROLE            = "api"
          DATABASE_URL    = local.dr_database_url
          AZURE_CLIENT_ID = azurerm_user_assigned_identity.app.client_id
          TRUST_PROXY     = var.enable_front_door ? "2" : "1"
        }, var.enable_front_door ? { EDGE_ID = azurerm_cdn_frontdoor_profile.main[0].resource_guid, EDGE_ID_MODE = var.edge_id_mode } : {})
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name        = "READER_TOKEN_KEY"
        secret_name = local.reader_token_secret.name
      }

      dynamic "env" {
        for_each = local.anthropic_secret ? [1] : []
        content {
          name        = "ANTHROPIC_API_KEY"
          secret_name = "anthropic-api-key"
        }
      }

      startup_probe {
        transport               = "HTTP"
        port                    = 3000
        path                    = "/healthz"
        interval_seconds        = 3
        failure_count_threshold = 20
      }

      liveness_probe {
        transport               = "HTTP"
        port                    = 3000
        path                    = "/healthz"
        interval_seconds        = 10
        failure_count_threshold = 3
      }

      # /readyz is one read: it passes on the replica, so the standby API is healthy while the database is read-only.
      readiness_probe {
        transport               = "HTTP"
        port                    = 3000
        path                    = "/readyz"
        interval_seconds        = 5
        failure_count_threshold = 3
      }
    }
  }

  # Key Vault references and the image pull are checked when the app is created, so the access, the private
  # path to the vault and the registry, and the outbound route must exist first.
  depends_on = [
    azurerm_role_assignment.app_vault_secrets,
    azurerm_role_assignment.app_acr_pull,
    azurerm_private_endpoint.dr_vault,
    azurerm_private_dns_zone_virtual_network_link.dr_vault,
    azurerm_private_endpoint.dr_acr,
    azurerm_private_dns_zone_virtual_network_link.dr_acr,
    azurerm_subnet_nat_gateway_association.dr_aca,
  ]

  lifecycle {
    ignore_changes = [template[0].container[0].image, template[0].min_replicas]
  }
}

resource "azurerm_container_app" "dr_worker" {
  count                        = local.dr ? 1 : 0
  name                         = "ca-${local.name}-worker-dr"
  container_app_environment_id = azurerm_container_app_environment.dr[0].id
  resource_group_name          = azurerm_resource_group.dr[0].name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  dynamic "secret" {
    for_each = local.anthropic_secret ? [1] : []
    content {
      name                = "anthropic-api-key"
      key_vault_secret_id = "${azurerm_key_vault.main.vault_uri}secrets/${var.anthropic_secret_name}"
      identity            = azurerm_user_assigned_identity.app.id
    }
  }

  template {
    min_replicas = 0 # the failover script raises it to the primary's floor after the promotion
    max_replicas = var.worker_replicas.max

    custom_scale_rule {
      name             = "cpu"
      custom_rule_type = "cpu"
      metadata = {
        type  = "Utilization"
        value = "70"
      }
    }

    container {
      name   = "worker"
      image  = var.api_image
      cpu    = 0.5
      memory = "1Gi"

      dynamic "env" {
        for_each = merge(local.common_env, { ROLE = "worker", DATABASE_URL = local.dr_database_url, AZURE_CLIENT_ID = azurerm_user_assigned_identity.app.client_id })
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.anthropic_secret ? [1] : []
        content {
          name        = "ANTHROPIC_API_KEY"
          secret_name = "anthropic-api-key"
        }
      }
    }
  }

  # Key Vault references and the image pull are checked when the app is created, so the access, the private
  # path to the vault and the registry, and the outbound route must exist first.
  depends_on = [
    azurerm_role_assignment.app_vault_secrets,
    azurerm_role_assignment.app_acr_pull,
    azurerm_private_endpoint.dr_vault,
    azurerm_private_dns_zone_virtual_network_link.dr_vault,
    azurerm_private_endpoint.dr_acr,
    azurerm_private_dns_zone_virtual_network_link.dr_acr,
    azurerm_subnet_nat_gateway_association.dr_aca,
  ]

  lifecycle {
    ignore_changes = [template[0].container[0].image, template[0].min_replicas]
  }
}

resource "azurerm_container_app" "dr_events" {
  for_each                     = local.dr ? var.consumer_sets : {}
  name                         = "ca-${local.name}-${each.key}-dr"
  container_app_environment_id = azurerm_container_app_environment.dr[0].id
  resource_group_name          = azurerm_resource_group.dr[0].name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  tags                         = merge(local.tags, { consumer_set = each.key })

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  secret {
    name                = local.reader_token_secret.name
    key_vault_secret_id = local.reader_token_secret.key_vault_secret_id
    identity            = local.reader_token_secret.identity
  }

  dynamic "secret" {
    for_each = local.anthropic_secret ? [1] : []
    content {
      name                = "anthropic-api-key"
      key_vault_secret_id = "${azurerm_key_vault.main.vault_uri}secrets/${var.anthropic_secret_name}"
      identity            = azurerm_user_assigned_identity.app.id
    }
  }

  template {
    min_replicas = 0 # nothing may write events while the database is a read-only replica
    max_replicas = each.value.max_replicas

    custom_scale_rule {
      name             = "cpu"
      custom_rule_type = "cpu"
      metadata = {
        type  = "Utilization"
        value = "70"
      }
    }

    container {
      name   = "events"
      image  = var.api_image
      cpu    = each.value.cpu
      memory = each.value.memory

      dynamic "env" {
        for_each = merge(
          local.common_env,
          local.reader_env,
          {
            ROLE                  = "events"
            REACTOR_CONSUMERS     = each.value.consumers
            DATABASE_URL          = local.dr_database_url
            AZURE_CLIENT_ID       = azurerm_user_assigned_identity.app.client_id
            PG_POOL_MAX           = "3"
            WEBHOOK_ALLOW_PRIVATE = "0"
          },
        )
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name        = "READER_TOKEN_KEY"
        secret_name = local.reader_token_secret.name
      }

      dynamic "env" {
        for_each = local.anthropic_secret ? [1] : []
        content {
          name        = "ANTHROPIC_API_KEY"
          secret_name = "anthropic-api-key"
        }
      }
    }
  }

  # Key Vault references and the image pull are checked when the app is created, so the access, the private
  # path to the vault and the registry, and the outbound route must exist first.
  depends_on = [
    azurerm_role_assignment.app_vault_secrets,
    azurerm_role_assignment.app_acr_pull,
    azurerm_private_endpoint.dr_vault,
    azurerm_private_dns_zone_virtual_network_link.dr_vault,
    azurerm_private_endpoint.dr_acr,
    azurerm_private_dns_zone_virtual_network_link.dr_acr,
    azurerm_subnet_nat_gateway_association.dr_aca,
  ]

  lifecycle {
    ignore_changes = [template[0].container[0].image, template[0].min_replicas]
  }
}

# ------------------------------------------------------------------ edge: the second region as a fallback origin

resource "azurerm_cdn_frontdoor_origin" "dr" {
  count                          = local.dr && var.enable_front_door ? 1 : 0
  name                           = "api-dr"
  cdn_frontdoor_origin_group_id  = azurerm_cdn_frontdoor_origin_group.api[0].id
  enabled                        = true
  host_name                      = azurerm_container_app.dr_api[0].ingress[0].fqdn
  origin_host_header             = azurerm_container_app.dr_api[0].ingress[0].fqdn
  certificate_name_check_enabled = true
  http_port                      = 80
  https_port                     = 443
  priority                       = 2 # used only when the priority-1 origin is unhealthy
  weight                         = 1000

  dynamic "private_link" {
    for_each = var.private_ingress ? [1] : []
    content {
      location               = azurerm_resource_group.dr[0].location
      private_link_target_id = azurerm_container_app_environment.dr[0].id
      target_type            = "managedEnvironments"
      request_message        = "Front Door ${local.name} (DR)"
    }
  }
}

# The deployment identity updates the second region's apps in the same pipeline run.
resource "azurerm_role_assignment" "deploy_contributor_dr" {
  count                = local.dr && var.github_repository != null ? 1 : 0
  scope                = azurerm_resource_group.dr[0].id
  role_definition_name = "Contributor"
  principal_id         = azurerm_user_assigned_identity.deploy[0].principal_id
}

resource "azurerm_network_security_group" "dr_private_endpoints" {
  count               = local.dr ? 1 : 0
  name                = "nsg-${local.name}-dr-pe"
  location            = azurerm_resource_group.dr[0].location
  resource_group_name = azurerm_resource_group.dr[0].name
  tags                = local.tags
}

resource "azurerm_subnet_network_security_group_association" "dr_private_endpoints" {
  count                     = local.dr ? 1 : 0
  subnet_id                 = azurerm_subnet.dr_private_endpoints[0].id
  network_security_group_id = azurerm_network_security_group.dr_private_endpoints[0].id
}
