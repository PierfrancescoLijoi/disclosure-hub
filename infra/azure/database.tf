resource "azurerm_postgresql_flexible_server" "main" {
  # checkov:skip=CKV2_AZURE_57: the server is VNet-integrated (delegated subnet, no public endpoint), which is the private-access mode; a private endpoint is the alternative, not an addition.
  # lint:allow protect deletion is blocked by the CanNotDelete lock in locks.tf (switchable on purpose) and by 14-day geo-redundant backups.
  name                = "psql-${local.unique}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  version             = "16"
  sku_name            = var.postgres_sku
  storage_mb          = var.postgres_storage_mb
  auto_grow_enabled   = true
  tags                = local.tags

  # Private only: reachable from the application subnet through the delegated subnet and private DNS.
  delegated_subnet_id           = azurerm_subnet.postgres.id
  private_dns_zone_id           = azurerm_private_dns_zone.postgres.id
  public_network_access_enabled = false

  # Entra only: no database password exists. The application connects with a managed identity token.
  authentication {
    active_directory_auth_enabled = true
    password_auth_enabled         = false
    tenant_id                     = data.azurerm_client_config.current.tenant_id
  }

  # A standby in another zone with synchronous replication: a zone loss or a patch is a short failover.
  zone = "1"
  high_availability {
    mode                      = "ZoneRedundant"
    standby_availability_zone = "2"
  }

  backup_retention_days        = var.postgres_backup_retention_days
  geo_redundant_backup_enabled = var.postgres_geo_redundant_backup

  maintenance_window {
    day_of_week  = 0 # Sunday, 02:00 UTC
    start_hour   = 2
    start_minute = 0
  }

  lifecycle {
    # After a failover the primary and standby zones swap; do not fight the platform.
    ignore_changes = [zone, high_availability[0].standby_availability_zone]
  }

  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]
}

# Administers the roles (scripts/bootstrap-roles.sql); sign-in as a group member with an Entra token.
resource "azurerm_postgresql_flexible_server_active_directory_administrator" "dba" {
  server_name         = azurerm_postgresql_flexible_server.main.name
  resource_group_name = azurerm_resource_group.main.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  object_id           = var.dba_group_object_id
  principal_name      = "dhub-dba"
  principal_type      = "Group"
}

resource "azurerm_postgresql_flexible_server_database" "hub" {
  name      = "hub"
  server_id = azurerm_postgresql_flexible_server.main.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# What an investigation needs: who connected, brute-force throttling, checkpoints, and slow statements
# (without logging every query).
resource "azurerm_postgresql_flexible_server_configuration" "logging" {
  for_each = {
    "log_connections"            = "on"
    "log_checkpoints"            = "on"
    "connection_throttle.enable" = "on"
    "log_min_duration_statement" = "500"
  }
  name      = each.key
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = each.value
}

locals {
  # postgres://<role>@host/db: the role is the managed identity's name; the password is an Entra token
  # the server code fetches at connection time.
  database_url = {
    app     = "postgres://${azurerm_user_assigned_identity.app.name}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/${azurerm_postgresql_flexible_server_database.hub.name}"
    migrate = "postgres://${azurerm_user_assigned_identity.migrate.name}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/${azurerm_postgresql_flexible_server_database.hub.name}"
  }
}
