locals {
  tenant_authority = "https://login.microsoftonline.com/${data.azurerm_client_config.current.tenant_id}/v2.0"

  # The same settings the local Compose file sets (docker-compose.yml): the code does not know which cloud
  # it runs in, these names select the adapters.
  common_env = {
    AUTH_MODE           = "oidc"
    OIDC_ISSUER         = local.tenant_authority
    OIDC_AUDIENCE       = azuread_application.api.client_id
    OIDC_ROLES_CLAIM    = "roles"
    OIDC_DEFAULT_ISSUER = var.default_company_id
    OIDC_AUTHORITY      = local.tenant_authority
    OIDC_SPA_CLIENT_ID  = azuread_application.web.client_id
    OIDC_SPA_SCOPE      = "api://${azuread_application.api.client_id}/access_as_user openid profile offline_access"
    DATABASE_AUTH       = "azure-managed-identity"
    PG_SSL              = "require"
    QUEUE_URL           = "pg"
    AUTO_MIGRATE        = "0"
    DEMO                = "0"
    PG_POOL_MAX         = "5"
    AI_PROVIDER         = var.ai_provider
    NODE_ENV            = "production"
    # Who gets an event is decided by the process that writes it, so every process must know the same agents,
    # not only the consumer set that runs them: otherwise the api never creates a delivery for the agent.
    # "none" is a placeholder: an unset or empty value would fall back to the provider default.
    AGENTS = local.auto_agents == "" ? "none" : local.auto_agents
  }

  auto_agents      = join(",", distinct(flatten([for s in var.consumer_sets : s.agents == null ? [] : [for a in split(",", s.agents) : trimspace(a)]])))
  anthropic_secret = var.ai_provider == "anthropic"
}

resource "azurerm_container_app_environment" "main" {
  name                       = "cae-${local.name}"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
  logs_destination           = "log-analytics"
  infrastructure_subnet_id   = azurerm_subnet.aca.id
  zone_redundancy_enabled    = true
  # No address on the internet: Front Door reaches the environment over Private Link (edge.tf). Disabling the
  # public address is only safe with the edge in place, so the two are tied together.
  public_network_access = var.private_ingress ? "Disabled" : "Enabled"
  tags                  = local.tags

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }

  lifecycle {
    ignore_changes = [infrastructure_resource_group_name]

    precondition {
      condition     = !var.private_ingress || var.enable_front_door
      error_message = "private_ingress closes the environment to the internet and Front Door is the only way in: set enable_front_door = true too."
    }
  }
}

# ------------------------------------------------------------------ api (also serves the web app)

resource "azurerm_container_app" "api" {
  name                         = local.api_app_name
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
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
    allow_insecure_connections = false # TLS terminates at the platform ingress; plain HTTP is redirected

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.api_replicas.min
    max_replicas = var.api_replicas.max

    # Scale on concurrent requests: one replica comfortably serves the whole small-company profile
    # (docs/SIZING.md), two exist for zone redundancy and rolling deploys, the rest is headroom.
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
          DATABASE_URL    = local.database_url.app
          AZURE_CLIENT_ID = azurerm_user_assigned_identity.app.client_id
          # Proxies in front of the app whose X-Forwarded-For entries are trusted, so per-client limits see the
          # reader: Front Door then the Container Apps ingress, or the ingress alone. Counted from the docs, not
          # observed: the first deploy checks it (README, "First apply").
          TRUST_PROXY = var.enable_front_door ? "2" : "1"
          }, var.enable_front_door ? { EDGE_ID = azurerm_cdn_frontdoor_profile.main[0].resource_guid, EDGE_ID_MODE = var.edge_id_mode } : {},
        var.read_replica ? { READ_DATABASE_URL = local.database_url.read } : {})
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

      # Not ready (database or queue down) takes the replica out of rotation without restarting it.
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
    azurerm_private_endpoint.vault,
    azurerm_private_dns_zone_virtual_network_link.vault,
    azurerm_private_endpoint.acr,
    azurerm_private_dns_zone_virtual_network_link.acr,
    azurerm_subnet_nat_gateway_association.aca,
  ]

  lifecycle {
    # The deployment pipeline owns the image; Terraform owns everything around it.
    ignore_changes = [template[0].container[0].image]
  }
}

# ------------------------------------------------------------------ worker (publication runner and sweeper)

resource "azurerm_container_app" "worker" {
  name                         = "ca-${local.name}-worker"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
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
    min_replicas = var.worker_replicas.min
    max_replicas = var.worker_replicas.max

    # No ingress, so no request count to scale on. The lease makes any number of workers safe, but CPU does NOT see a
    # publishing backlog: a worker waiting on a slow vendor is idle. So this rule is only a safety net and the real
    # capacity is the floor (2 workers, about 15 publications/s measured, against a peak of 0.17/s). The backlog is
    # watched by the publication_backlog alert (monitoring.tf), and the person who gets it raises worker_replicas.min.
    # A backlog-driven scaler needs a signal KEDA can read without a credential: the database is Entra-only (no
    # password for a postgresql scaler) and /metrics sits behind the edge check. The backlog scaler arrives with
    # Service Bus (KEDA azure-servicebus, managed identity), at the triggers in docs/adr/0001.
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
        for_each = merge(local.common_env, { ROLE = "worker", DATABASE_URL = local.database_url.app, AZURE_CLIENT_ID = azurerm_user_assigned_identity.app.client_id })
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

# ------------------------------------------------------------------ migrate (run by the pipeline before every rollout)

resource "azurerm_container_app_job" "migrate" {
  name                         = "caj-${local.name}-migrate"
  location                     = azurerm_resource_group.main.location
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 600
  replica_retry_limit          = 1
  tags                         = local.tags

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.migrate.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.migrate.id
  }

  template {
    container {
      name    = "migrate"
      image   = var.api_image
      cpu     = 0.25
      memory  = "0.5Gi"
      command = ["node", "apps/server/dist/migrate.js"]

      dynamic "env" {
        for_each = merge(local.common_env, {
          DATABASE_URL      = local.database_url.migrate
          AZURE_CLIENT_ID   = azurerm_user_assigned_identity.migrate.client_id
          SEED_ISSUERS_JSON = var.issuers_json
          PG_POOL_MAX       = "2"
        })
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].container[0].image]
  }
}
