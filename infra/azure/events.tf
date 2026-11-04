# The extension seam in the cloud. Each entry of var.consumer_sets is its own Container App running the same
# image with ROLE=events: it drains the shared event outbox (domain_events / event_deliveries in the
# database) but only for the consumers it names. A slow mail service or an expensive model therefore
# cannot slow publishing or another consumer, and each set scales, fails and is alerted on by itself.
# The local twin has the same shape (notifier and agents services in docker-compose.yml).

resource "azurerm_container_app" "events" {
  for_each                     = var.consumer_sets
  name                         = "ca-${local.name}-${each.key}"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
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
    # At least one replica: nothing wakes a scaled-to-zero poller when an event is written. More than one is
    # safe because every delivery is leased, so two replicas never handle the same one.
    min_replicas = each.value.min_replicas
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
            DATABASE_URL          = local.database_url.app
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
    azurerm_private_endpoint.vault,
    azurerm_private_dns_zone_virtual_network_link.vault,
    azurerm_private_endpoint.acr,
    azurerm_private_dns_zone_virtual_network_link.acr,
    azurerm_subnet_nat_gateway_association.aca,
  ]

  lifecycle {
    ignore_changes = [template[0].container[0].image]
  }
}
